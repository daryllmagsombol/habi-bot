#!/usr/bin/env node
/**
 * H-025 P1 acceptance harness.
 *
 * One command, one disposable PostgreSQL 18.6 container, the real compiled
 * backend, real migrations, real services, and a local Hermes-compatible stub
 * where a scenario needs execution. Reports go to a temp directory by default.
 *
 * Usage:
 *   node scripts/acceptance/run.mjs
 *   node scripts/acceptance/run.mjs --scenario isolation,auth
 *   node scripts/acceptance/run.mjs --list
 *
 * Exit codes:
 *   0  no scenario failed (blocked scenarios may remain — that is not a P1 go)
 *   1  at least one scenario failed
 *   2  usage/environment error before scenarios could run
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPOSITORY_ROOT,
  run,
} from './lib/process.mjs';
import { createContext } from './lib/context.mjs';
import { scenarioIds, scenarios } from './scenarios/index.mjs';
import {
  buildReport,
  createCheck,
  createScenario,
  parseScenarioFilter,
  renderMarkdown,
  selectScenarios,
  summarize,
} from './lib/report.mjs';

const SCENARIO_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
  const options = {
    filter: [],
    outDir: undefined,
    build: false,
    keep: false,
    list: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case '--scenario':
      case '--scenarios': {
        const value = argv[index + 1];

        if (value === undefined) {
          throw new Error('--scenario needs a comma-separated value');
        }

        options.filter = parseScenarioFilter(value, scenarioIds);
        index += 1;
        break;
      }
      case '--out': {
        const value = argv[index + 1];

        if (value === undefined) {
          throw new Error('--out needs a directory');
        }

        options.outDir = value;
        index += 1;
        break;
      }
      case '--build':
        options.build = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--list':
        options.list = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

function usage() {
  return [
    'Usage: node scripts/acceptance/run.mjs [options]',
    '',
    '  --scenario <ids>  Comma-separated scenario filter (see --list)',
    '  --out <dir>       Report directory (default: a fresh temp directory)',
    '  --build           Rebuild @habi/contracts and @habi/backend first',
    '  --keep            Keep the PostgreSQL container after the run',
    '  --list            List scenario ids and exit',
    '  --help            Show this help',
    '',
    'Exit 0 means no scenario failed. Blocked scenarios remain incomplete;',
    'this harness never declares a P1 go.',
  ].join('\n');
}

function ensureBuild(force) {
  const main = join(REPOSITORY_ROOT, 'apps/backend/dist/main.js');
  const worker = join(REPOSITORY_ROOT, 'apps/backend/dist/worker.js');

  if (force !== true && existsSync(main) === true && existsSync(worker) === true) {
    return 'existing dist';
  }

  for (const args of [
    ['--filter', '@habi/contracts', 'build'],
    ['--filter', '@habi/backend', 'build'],
  ]) {
    const result = run('pnpm', args, { timeoutMs: 300_000 });

    if (result.status !== 0) {
      throw new Error(
        `Build failed: pnpm ${args.join(' ')}\n` +
          `${(result.stdout ?? '').slice(-3000)}\n${(result.stderr ?? '').slice(-3000)}`,
      );
    }
  }

  return 'built by harness';
}

async function runScenario(scenario, ctx) {
  const startedAt = new Date().toISOString();

  try {
    const result = await Promise.race([
      scenario.run(ctx),
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Scenario exceeded ${SCENARIO_TIMEOUT_MS}ms`));
        }, SCENARIO_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);

    return createScenario({
      id: scenario.id,
      title: scenario.title,
      checks: result.checks,
      evidence: result.evidence,
      blockers: result.blockers,
      residualRisks: result.residualRisks,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    return createScenario({
      id: scenario.id,
      title: scenario.title,
      checks: [
        createCheck({
          name: 'scenario completed',
          status: 'fail',
          detail: error instanceof Error ? error.message : String(error),
        }),
      ],
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }
}

function blockedByDocker(scenario) {
  return createScenario({
    id: scenario.id,
    title: scenario.title,
    checks: [
      createCheck({
        name: 'Docker daemon is available',
        status: 'blocked',
        detail:
          'Docker is unavailable, so the disposable PostgreSQL container and the scenarios that need it did not run.',
      }),
    ],
    blockers: ['Docker daemon unavailable on this host.'],
  });
}

function printMatrix(report) {
  const summary = summarize(report.scenarios);

  console.log('');
  console.log('P1 acceptance matrix');
  console.log('--------------------');

  for (const scenario of report.scenarios) {
    console.log(
      `${scenario.status.toUpperCase().padEnd(8)} ${scenario.id.padEnd(22)} ${scenario.title}`,
    );

    for (const check of scenario.checks) {
      const detail = check.detail === undefined ? '' : ` — ${check.detail}`;

      console.log(`  ${check.status.padEnd(8)} ${check.name}${detail}`);
    }
  }

  console.log('');
  console.log(summary.line);
  console.log('');
}

/** Parses argv, or reports the usage error and returns null. */
function readOptions(argv) {
  try {
    return parseArgs(argv);
  } catch (error) {
    console.error(`acceptance: ${error.message}`);
    console.error(usage());
    return null;
  }
}

function printScenarioList() {
  for (const scenario of scenarios) {
    console.log(`${scenario.id}\t${scenario.title}`);
  }
}

/**
 * Runs the selected scenarios and always tears the context down. Without
 * Docker only `vm-impact` can run; the rest are reported as blocked.
 */
async function executeScenarios(context, selected, { keep = false } = {}) {
  const dockerReady = context.dockerReady === true;
  const scenariosToRun = dockerReady
    ? selected
    : selected.filter((scenario) => scenario.id === 'vm-impact');
  const runResults = [];

  try {
    for (const scenario of scenariosToRun) {
      process.stderr.write(`acceptance: running ${scenario.id}...\n`);
      runResults.push(await runScenario(scenario, context));
      process.stderr.write(
        `acceptance: ${scenario.id} ${runResults.at(-1).status}\n`,
      );
    }
  } finally {
    if (keep === true && dockerReady) {
      console.error(
        `acceptance: keeping container ${context.postgres.containerName} (database URL withheld)`,
      );
    } else {
      await context.teardown().catch((error) => {
        console.error(`acceptance: teardown failed: ${error.message}`);
      });
    }
  }

  const blockedResults = dockerReady
    ? []
    : selected
        .filter((scenario) => scenario.id !== 'vm-impact')
        .map(blockedByDocker);

  return [...runResults, ...blockedResults];
}

/** Preserves the declared order even when Docker skipped some scenarios. */
function orderResults(selected, results) {
  return selected.map((scenario) => {
    const result = results.find((candidate) => candidate.id === scenario.id);

    return (
      result ??
      createScenario({
        id: scenario.id,
        title: scenario.title,
        checks: [
          createCheck({
            name: 'scenario executed',
            status: 'blocked',
            detail: 'The scenario did not produce a result.',
          }),
        ],
      })
    );
  });
}

async function writeArtifacts(outDir, report) {
  const jsonPath = join(outDir, 'acceptance-report.json');
  const markdownPath = join(outDir, 'acceptance-report.md');

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');

  return { jsonPath, markdownPath };
}

async function main() {
  const options = readOptions(process.argv.slice(2));

  if (options === null) {
    process.exitCode = 2;
    return;
  }

  if (options.help === true) {
    console.log(usage());
    return;
  }

  if (options.list === true) {
    printScenarioList();
    return;
  }

  let buildNote;

  try {
    buildNote = ensureBuild(options.build);
  } catch (error) {
    console.error(`acceptance: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const outDir =
    options.outDir ?? (await mkdtemp(join(tmpdir(), 'habi-acceptance-report-')));

  await mkdir(outDir, { recursive: true });

  const selected = selectScenarios(scenarios, options.filter);
  const context = await createContext({ outDir, keep: options.keep });
  const results = await executeScenarios(context, selected, {
    keep: options.keep,
  });
  const ordered = orderResults(selected, results);

  const report = buildReport({
    scenarios: ordered,
    environment: {
      ...context.environment,
      build: buildNote,
      reportDirectory: outDir,
    },
    harness: {
      name: 'habi-p1-acceptance',
      version: 1,
      command: `node scripts/acceptance/run.mjs ${process.argv.slice(2).join(' ')}`.trim(),
    },
  });

  const { jsonPath, markdownPath } = await writeArtifacts(outDir, report);

  printMatrix(report);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${markdownPath}`);
  console.log(
    'Reminder: P1 exit is an owner decision. This harness does not declare go, and a blocked scenario is not a pass.',
  );

  process.exitCode = report.summary.exitCode;
}

try {
  await main();
} catch (error) {
  console.error(
    `acceptance: environment error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 2;
}
