import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const workflow = readFileSync(
  path.join(ROOT, '.github/workflows/sonarqube.yml'),
  'utf8',
);
const properties = readFileSync(
  path.join(ROOT, 'sonar-project.properties'),
  'utf8',
);
const docs = readFileSync(path.join(ROOT, 'docs/ci/sonarqube.md'), 'utf8');
const sonarConfig = JSON.parse(
  readFileSync(path.join(ROOT, 'tsconfig.sonar.json'), 'utf8'),
);

function extractRunBlock(workflowText, stepName) {
  const lines = workflowText.split(/\r?\n/);
  const stepLine = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );

  assert.notEqual(stepLine, -1, `Missing workflow step: ${stepName}`);

  let runLine = -1;

  for (let index = stepLine + 1; index < lines.length; index += 1) {
    if (lines[index].trim().startsWith('- name:')) {
      break;
    }

    if (lines[index].trim() === 'run: |') {
      runLine = index;
      break;
    }
  }

  assert.notEqual(runLine, -1, `Missing run block for: ${stepName}`);

  const runIndent = lines[runLine].match(/^ */)[0].length;
  const block = [];

  for (let index = runLine + 1; index < lines.length; index += 1) {
    const line = lines[index];

    if (line.trim() === '') {
      block.push('');
      continue;
    }

    const indent = line.match(/^ */)[0].length;

    if (indent <= runIndent) {
      break;
    }

    block.push(line.slice(runIndent + 2));
  }

  return `${block.join('\n').replace(/\n+$/, '')}\n`;
}

function runPreflight(overrides) {
  const directory = mkdtempSync(path.join(tmpdir(), 'habi-sonar-preflight-'));
  const scriptPath = path.join(directory, 'preflight.sh');
  const outputPath = path.join(directory, 'github-output');
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    ...overrides,
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    }
  }

  writeFileSync(
    scriptPath,
    extractRunBlock(workflow, 'Preflight SonarQube configuration'),
  );

  try {
    const result = spawnSync('bash', [scriptPath], {
      encoding: 'utf8',
      env,
    });
    const output = existsSync(outputPath)
      ? readFileSync(outputPath, 'utf8')
      : '';

    return { result, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function actionSha(action) {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`${escaped}@([0-9a-f]{40})`));

  assert.ok(match, `Missing full-SHA pin for ${action}`);
  return match[1];
}

test('preflight skips cleanly when configuration is missing', () => {
  const { result, output } = runPreflight({
    SONAR_HOST_URL: '',
    SONAR_PROJECT_KEY: '',
    SONAR_TOKEN: '',
  });

  assert.equal(result.status, 0);
  assert.match(output, /^configured=false$/m);
  assert.match(result.stdout, /configuration incomplete; scan skipped/);
});

test('preflight accepts valid HTTPS configuration without printing the token', () => {
  const token = 'test-token-sentinel';
  const { result, output } = runPreflight({
    SONAR_HOST_URL: 'https://sonar.example.test',
    SONAR_PROJECT_KEY: 'habi',
    SONAR_TOKEN: token,
  });

  assert.equal(result.status, 0);
  assert.match(output, /^configured=true$/m);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${output}`, new RegExp(token));
});

test('preflight rejects non-HTTPS hosts without printing the token', () => {
  const token = 'test-token-sentinel';
  const { result, output } = runPreflight({
    SONAR_HOST_URL: 'http://sonar.example.test',
    SONAR_PROJECT_KEY: 'habi',
    SONAR_TOKEN: token,
  });

  assert.equal(result.status, 1);
  assert.equal(output, '');
  assert.match(result.stderr, /must use HTTPS/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${output}`, new RegExp(token));
});

test('preflight rejects malformed, credentialed, query, fragment, and newline hosts', () => {
  const token = 'test-token-sentinel';

  for (const host of [
    'not-a-url',
    'https://user:pass@sonar.example.test',
    'https://sonar.example.test?x=1',
    'https://sonar.example.test#frag',
    'https://sonar.example.test//',
    'https://sonar.example.test\n',
  ]) {
    const { result, output } = runPreflight({
      SONAR_HOST_URL: host,
      SONAR_PROJECT_KEY: 'habi',
      SONAR_TOKEN: token,
    });

    assert.equal(result.status, 1, host);
    assert.equal(output, '', host);
    assert.match(`${result.stdout}${result.stderr}`, /SONAR_HOST_URL/, host);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}${output}`,
      new RegExp(token),
      host,
    );
  }
});

test('preflight rejects unsafe project keys', () => {
  const token = 'test-token-sentinel';

  for (const key of [
    '12345',
    'habi key',
    'foo" -Dsonar.host.url=evil',
    'foo/bar',
    'foo\nbar',
  ]) {
    const { result, output } = runPreflight({
      SONAR_HOST_URL: 'https://sonar.example.test',
      SONAR_PROJECT_KEY: key,
      SONAR_TOKEN: token,
    });

    assert.equal(result.status, 1, key);
    assert.equal(output, '', key);
    assert.match(`${result.stdout}${result.stderr}`, /SONAR_PROJECT_KEY/, key);
    assert.doesNotMatch(
      `${result.stdout}${result.stderr}${output}`,
      new RegExp(token),
      key,
    );
  }
});

test('workflow triggers and PR guards are restricted', () => {
  assert.match(workflow, /push:\s*\n\s*branches:\s*\n\s*-\s*main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request:\s*\n\s*types:/);

  for (const type of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    assert.match(workflow, new RegExp(`-\\s*${type}`));
  }

  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(workflow, /github\.event\.pull_request\.draft == false/);
  assert.match(workflow, /vars\.SONAR_PR_ANALYSIS_ENABLED == 'true'/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(workflow, /pull_request_target/);
});

test('workflow pins actions and keeps read-only security settings', () => {
  assert.equal(
    actionSha('actions/checkout'),
    '3d3c42e5aac5ba805825da76410c181273ba90b1',
  );
  assert.equal(
    actionSha('actions/setup-node'),
    '949feb2413d6458794dcd2491c4babbbce0c15c1',
  );
  assert.equal(
    actionSha('SonarSource/sonarqube-scan-action'),
    'd209202bc7d53ff1cc128f7f907dac145c9d6ae9',
  );

  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /timeout-minutes:\s*20/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /scannerVersion:\s*8\.2\.0\.6438/);
  assert.doesNotMatch(workflow, /-Dsonar\.host\.url=/);
  assert.match(
    workflow,
    /"-Dsonar\.projectKey=\$\{\{ vars\.SONAR_PROJECT_KEY \}\}"/,
  );
  assert.match(workflow, /"-Dsonar\.qualitygate\.wait=true"/);
  assert.match(workflow, /"-Dsonar\.qualitygate\.timeout=300"/);
  assert.equal(
    (workflow.match(/steps\.preflight\.outputs\.configured == 'true'/g) ?? [])
      .length,
    3,
  );
  assert.ok(
    workflow.indexOf('Preflight SonarQube configuration') <
      workflow.indexOf('Check out repository'),
  );
  assert.match(workflow, /SONAR_ROOT_CERT:/);
  assert.match(workflow, /SONAR_HOST_URL:/);
  assert.equal(
    (workflow.match(/^\s+SONAR_TOKEN:\s+\$\{\{\s*secrets\.SONAR_TOKEN\s*\}\}/gm) ?? []).length,
    2,
  );

  assert.doesNotMatch(workflow, /id-token/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.doesNotMatch(workflow, /self-hosted/);
  assert.doesNotMatch(workflow, /pnpm install|npm install|yarn install|corepack/);
});

test('project properties keep scope narrow and avoid fake coverage', () => {
  for (const source of [
    'apps/web/app',
    'apps/backend/src',
    'packages/contracts/src',
    'packages/config/eslint',
    'scripts',
  ]) {
    assert.ok(properties.includes(source), `Missing source root: ${source}`);
  }

  for (const testRoot of [
    'apps/backend/test',
    'apps/web/test',
    'packages/config/test',
    'packages/contracts/test',
  ]) {
    assert.ok(properties.includes(testRoot), `Missing test root: ${testRoot}`);
  }

  for (const exclusion of [
    '**/node_modules/**',
    '**/dist/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/next-env.d.ts',
    '**/*.tsbuildinfo',
    'scripts/**/*.test.mjs',
    'docs/**',
  ]) {
    assert.ok(properties.includes(exclusion), `Missing exclusion: ${exclusion}`);
  }

  assert.doesNotMatch(properties, /sonar\.projectKey/);
  assert.doesNotMatch(properties, /lcov/i);
  assert.doesNotMatch(properties, /sonar\.branch\.name|sonar\.pullrequest/);
  assert.doesNotMatch(
    `${workflow}\n${properties}\n${docs}`,
    /sonarcloud\.io|https?:\/\/sonar\./i,
  );
});

test('standalone Sonar TSConfig is analyzer-only and covers source roots', () => {
  assert.equal(sonarConfig.extends, undefined);
  assert.equal(sonarConfig.references, undefined);
  assert.equal(sonarConfig.compilerOptions.types.length, 0);
  assert.equal(sonarConfig.compilerOptions.noEmit, true);
  assert.equal(sonarConfig.compilerOptions.strict, true);
  assert.equal(sonarConfig.compilerOptions.skipLibCheck, true);
  assert.equal(sonarConfig.compilerOptions.jsx, 'preserve');
  assert.equal(sonarConfig.compilerOptions.module, 'ESNext');
  assert.equal(sonarConfig.compilerOptions.moduleResolution, 'Bundler');
  assert.equal(sonarConfig.compilerOptions.experimentalDecorators, true);
  assert.equal(sonarConfig.compilerOptions.target, 'ES2023');
  assert.equal(sonarConfig.compilerOptions.allowJs, true);

  for (const include of [
    'apps/backend/src/**/*.ts',
    'apps/web/app/**/*.ts',
    'apps/web/app/**/*.tsx',
    'packages/contracts/src/**/*.ts',
    'packages/config/eslint/**/*.mjs',
    'scripts/**/*.mjs',
  ]) {
    assert.ok(sonarConfig.include.includes(include), `Missing include: ${include}`);
  }

  assert.ok(!JSON.stringify(sonarConfig).includes('@types'));
  assert.ok(!sonarConfig.compilerOptions.paths);
  assert.ok(!sonarConfig.compilerOptions.baseUrl);
  assert.ok(!sonarConfig.compilerOptions.typeRoots);
  assert.match(
    properties,
    /^sonar\.typescript\.tsconfigPaths=tsconfig\.sonar\.json$/m,
  );
});

test('docs describe required configuration and limitations', () => {
  for (const phrase of [
    'Developer Edition or higher',
    'SONAR_HOST_URL',
    'SONAR_PROJECT_KEY',
    'SONAR_PR_ANALYSIS_ENABLED',
    'SONAR_TOKEN',
    'SONAR_ROOT_CERT',
    'same repository',
    'draft',
    'fork',
    'HTTPS',
    'quality gate',
    'coverage',
    'self-hosted',
    'tsconfig.sonar.json',
    'sonar.typescript.tsconfigPaths',
    'limited type precision',
    'actual server analysis remains unverified',
  ]) {
    assert.ok(docs.includes(phrase), `Missing documentation phrase: ${phrase}`);
  }

  assert.match(docs, /Do not set `sonar\.branch\.name`/);
  assert.match(docs, /No .*LCOV|no LCOV/i);
  assert.match(docs, /does not install dependencies/i);
});
