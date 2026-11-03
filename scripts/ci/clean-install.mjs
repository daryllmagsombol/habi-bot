#!/usr/bin/env node
/**
 * H-009 clean-install / reproducibility evidence runner.
 *
 * Proves that the committed tree installs from a cold pnpm store and then
 * builds, typechecks, and tests without reusing any local install or cache:
 *
 *   1. archive   `git archive HEAD` extracted into a fresh temp tree (HEAD only,
 *                no untracked or modified working-tree files)
 *   2. preflight exactly one lockfile, pnpm version from `packageManager`, cold store
 *   3. install   `pnpm install --frozen-lockfile --store-dir <temp>/store`
 *   4. build     `pnpm build`
 *   5. typecheck `pnpm typecheck`
 *   6. test      `pnpm test`
 *
 * The temp tree lives outside the repository and is removed on exit, including
 * on failure, unless `--keep` is passed. Nothing in this script writes inside
 * the repository.
 *
 * Child processes never resolve executables through PATH: git and tar are
 * resolved to absolute system paths and corepack/pnpm run through the current
 * node binary. The child PATH is rebuilt from core system directories, plus a
 * private `node`/`pnpm` shim directory for what the toolchain runs itself.
 *
 * Usage:
 *   node scripts/ci/clean-install.mjs [--dry-run] [--keep]
 *                                     [--source <git-repo>] [--archive <tar>]
 *                                     [--temp-root <dir>] [--help]
 *
 * Exit codes: 0 success, 1 step failure, 2 usage or preflight failure.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
export const STEP_NAMES = ['archive', 'install', 'build', 'typecheck', 'test'];
export const LOCKFILE_CANDIDATES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'bun.lock',
  'bun.lockb',
];
export const TEMP_PREFIX = 'habi-clean-install-';
export const EXIT_OK = 0;
export const EXIT_STEP_FAILED = 1;
export const EXIT_USAGE = 2;
export const TAIL_LIMIT = 8000;
/** Environment variables that could make a cached or remote build look cold. */
export const STRIPPED_ENV = [
  'TURBO_TOKEN',
  'TURBO_TEAM',
  'TURBO_REMOTE_CACHE_SIGNATURE_KEY',
  'TURBO_CACHE',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];
/**
 * Fixed, absolute search directories for child processes: core system
 * locations only. The inherited `process.env.PATH` is never reused, and the
 * node install directory, Homebrew, and `/usr/local` are deliberately absent,
 * so an outside writable directory cannot supply a binary this runner or its
 * toolchain executes.
 */
export const SYSTEM_PATH_DIRECTORIES = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * Builds a deterministic PATH from existing absolute system directories only.
 * Deliberately does not read `process.env.PATH` and never includes the node or
 * package-manager install directories. The toolchain's own `node` and `pnpm`
 * lookups are served by a private shim directory added for the install steps.
 */
export function childPath(directories = SYSTEM_PATH_DIRECTORIES) {
  return [...new Set(directories)]
    .filter((directory) => path.isAbsolute(directory) && existsSync(directory))
    .join(path.delimiter);
}

/**
 * Resolves a tool to an absolute path inside the fixed system directories.
 * Throws instead of falling back to a bare name, so no PATH lookup occurs.
 */
export function resolveSystemTool(name, directories = SYSTEM_PATH_DIRECTORIES) {
  for (const directory of directories) {
    const candidate = path.join(directory, name);

    if (path.isAbsolute(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }

  throw new PreflightError(
    [
      `Required tool "${name}" was not found in: ${directories.join(', ')}.`,
      'Install it in a standard system location and re-run.',
    ].join('\n'),
  );
}

export class UsageError extends Error {}
export class PreflightError extends Error {}
export class StepFailedError extends Error {}

function log(message) {
  console.log(`[clean-install] ${message}`);
}

function logError(message) {
  console.error(`[clean-install] ${message}`);
}

export function formatDuration(milliseconds) {
  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  return `${(milliseconds / 1000).toFixed(1)}s`;
}

export function isInsideRepo(targetPath, repoRoot = REPO_ROOT) {
  const relative = path.relative(path.resolve(repoRoot), path.resolve(targetPath));

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertOutsideRepo(targetPath, repoRoot = REPO_ROOT) {
  if (isInsideRepo(targetPath, repoRoot)) {
    throw new UsageError(
      `Refusing to write inside the repository (${repoRoot}): ${targetPath}. Pass an outside --temp-root.`,
    );
  }
}

const BOOLEAN_FLAGS = new Map([
  ['--dry-run', 'dryRun'],
  ['--keep', 'keep'],
  ['--help', 'help'],
  ['-h', 'help'],
]);
const VALUE_FLAGS = new Map([
  ['--source', 'source'],
  ['--archive', 'archive'],
  ['--temp-root', 'tempRoot'],
]);

function readFlagValue(argv, index, flag) {
  const value = argv[index + 1];

  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`Missing value for ${flag}.`);
  }

  return value;
}

/** Applies the argument at `index` and returns the index of the next one. */
function applyArgument(options, argv, index) {
  const arg = argv[index];

  if (BOOLEAN_FLAGS.has(arg)) {
    options[BOOLEAN_FLAGS.get(arg)] = true;

    return index + 1;
  }

  if (VALUE_FLAGS.has(arg)) {
    options[VALUE_FLAGS.get(arg)] = readFlagValue(argv, index, arg);

    return index + 2;
  }

  throw new UsageError(`Unknown argument: ${arg}`);
}

export function parseArgs(argv = []) {
  const options = {
    dryRun: false,
    keep: false,
    help: false,
    source: null,
    archive: null,
    tempRoot: null,
  };
  let index = 0;

  while (index < argv.length) {
    index = applyArgument(options, argv, index);
  }

  if (options.source && options.archive) {
    throw new UsageError('--source and --archive are mutually exclusive.');
  }

  return options;
}

export function printUsage(stream = process.stdout) {
  stream.write(
    [
      'Usage: node scripts/ci/clean-install.mjs [options]',
      '',
      'Options:',
      '  --dry-run            Print the plan and exit 0 without installing.',
      '  --keep               Keep the temp tree (it is outside the repository).',
      '  --source <dir>       Git repository to archive (default: this repository).',
      '  --archive <tar>      Extract a prebuilt archive instead of `git archive HEAD`.',
      '  --temp-root <dir>    Parent directory for the temp tree (default: OS tmpdir).',
      '  --help               Show this help.',
      '',
    ].join('\n'),
  );
}

export function stepEnvironment(base = process.env) {
  const env = { ...base };

  for (const key of STRIPPED_ENV) {
    delete env[key];
  }

  env.CI = '1';
  env.DO_NOT_TRACK = '1';
  env.TURBO_TELEMETRY_DISABLED = '1';
  env.NEXT_TELEMETRY_DISABLED = '1';
  env.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0';
  // Always override the inherited PATH with system-only directories;
  // HOME/TMPDIR and tool config stay as-is. Executables this runner spawns are
  // resolved to absolute paths, so PATH never locates them.
  env.PATH = childPath();

  return env;
}

export function readPackageManagerPin(packageJsonPath) {
  if (!existsSync(packageJsonPath)) {
    throw new PreflightError(`Missing package.json: ${packageJsonPath}`);
  }

  let parsed;

  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch (error) {
    throw new PreflightError(`package.json is not valid JSON: ${error.message}`);
  }

  const field = parsed.packageManager;

  if (typeof field !== 'string' || !field.includes('@')) {
    throw new PreflightError(
      'package.json is missing a "packageManager" pin (expected "pnpm@<version>").',
    );
  }

  const separator = field.lastIndexOf('@');
  const name = field.slice(0, separator);
  const version = field.slice(separator + 1).split('+')[0];

  if (name !== 'pnpm' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new PreflightError(
      `Unsupported "packageManager" value "${field}"; expected "pnpm@<semver>".`,
    );
  }

  return { name, version, field };
}

export function readNodeVersionPin(sourceRoot) {
  const pinPath = path.join(sourceRoot, '.node-version');

  if (!existsSync(pinPath)) {
    return null;
  }

  const value = readFileSync(pinPath, 'utf8').trim().replace(/^v/, '');

  return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
}

export function inspectLockfiles(treeDir) {
  const present = LOCKFILE_CANDIDATES.filter((name) => existsSync(path.join(treeDir, name)));

  if (present.length === 0) {
    throw new PreflightError(
      [
        'No lockfile in the archived tree; a clean install requires a committed lockfile.',
        'Expected pnpm-lock.yaml at the repository root. Commit the lockfile, then re-run.',
      ].join('\n'),
    );
  }

  if (present.length > 1) {
    throw new PreflightError(
      `Expected exactly one lockfile, found ${present.length}: ${present.join(', ')}.`,
    );
  }

  if (present[0] !== 'pnpm-lock.yaml') {
    throw new PreflightError(`Expected pnpm-lock.yaml, found ${present[0]}.`);
  }

  const contents = readFileSync(path.join(treeDir, 'pnpm-lock.yaml'));

  return {
    name: 'pnpm-lock.yaml',
    bytes: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

const NODE_SCRIPT_EXTENSION = /\.[cm]?js$/i;

/**
 * A launcher is an absolute executable plus arguments that must always precede
 * the step arguments. Node-based shims (corepack, a pnpm js shim) run through
 * the current node binary, so no PATH lookup happens at spawn time.
 */
function nodeScriptCommand(scriptPath, execPath = process.execPath) {
  return { executable: execPath, baseArgs: [scriptPath] };
}

function resolveIfPresent(candidate) {
  try {
    if (!statSync(candidate).isFile()) {
      return null;
    }

    const resolved = realpathSync(candidate);

    return statSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

/** Resolves the corepack shim shipped with the running node install, if any. */
export function corepackCommand(execPath = process.execPath) {
  const shim = path.join(path.dirname(execPath), 'corepack');
  const resolved = resolveIfPresent(shim);

  return resolved === null ? null : nodeScriptCommand(resolved, execPath);
}

/**
 * Fallback when corepack is unavailable: the `pnpm`/`pnpm.cjs` shim next to
 * node, or corepack's bundled pnpm shim. Returns null when none resolves.
 */
export function pnpmCommand(execPath = process.execPath) {
  const nodeDir = path.dirname(execPath);
  const candidates = [
    path.join(nodeDir, 'pnpm'),
    path.join(nodeDir, 'pnpm.cjs'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'corepack', 'dist', 'pnpm.js'),
  ];

  for (const candidate of candidates) {
    const resolved = resolveIfPresent(candidate);

    if (resolved === null) {
      continue;
    }

    return NODE_SCRIPT_EXTENSION.test(resolved)
      ? nodeScriptCommand(resolved, execPath)
      : { executable: resolved, baseArgs: [] };
  }

  return null;
}

/** Expands a launcher and step arguments into a concrete spawn command. */
export function spawnCommand(launcher, args = []) {
  return {
    executable: launcher.executable,
    args: [...(launcher.baseArgs ?? []), ...args],
  };
}

/** Human-readable form of a launcher command, for logs and error messages. */
export function displayCommand(launcher, args = []) {
  const command = spawnCommand(launcher, args);

  return [command.executable, ...command.args].join(' ');
}

const SHELL_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

function shellQuote(value) {
  return `'${value.replaceAll("'", SHELL_SINGLE_QUOTE_ESCAPE)}'`;
}

/**
 * Writes the private `node`/`pnpm` shims used by the installed toolchain into
 * `binDir`. Both entry points are absolute: `node` links to the running node
 * binary and `pnpm` execs the resolved launcher, so neither needs a PATH
 * lookup. pnpm lifecycle scripts, `#!/usr/bin/env node` bin shims, and turbo's
 * package-manager discovery all resolve their interpreter from PATH, and pnpm
 * 12.5.1 has no working script-shell setting to supply it another way.
 */
export function writeToolShims(binDir, launcher, execPath = process.execPath) {
  const nodeShim = path.join(binDir, 'node');
  const pnpmShim = path.join(binDir, 'pnpm');
  const command = [launcher.executable, ...launcher.baseArgs].map(shellQuote).join(' ');
  const script = [
    '#!/bin/sh',
    '# Generated by scripts/ci/clean-install.mjs. Runs the pinned pnpm launcher',
    '# by absolute path so no PATH lookup is needed to find it.',
    `exec ${command} "$@"`,
    '',
  ].join('\n');

  mkdirSync(binDir, { recursive: true });
  rmSync(nodeShim, { force: true });
  symlinkSync(execPath, nodeShim);
  writeFileSync(pnpmShim, script, { mode: 0o755 });
  chmodSync(pnpmShim, 0o755);

  return { binDir, nodeShim, pnpmShim };
}

export function detectPnpmLauncher({
  cwd = REPO_ROOT,
  env = stepEnvironment(),
  execPath = process.execPath,
} = {}) {
  const corepack = corepackCommand(execPath);

  if (corepack !== null) {
    const { executable, args } = spawnCommand(corepack, ['--version']);
    const check = spawnSync(executable, args, { cwd, env, encoding: 'utf8' });

    if (!check.error && check.status === 0) {
      return {
        source: 'corepack',
        executable,
        baseArgs: [...corepack.baseArgs, 'pnpm'],
        corepackVersion: (check.stdout ?? '').trim(),
      };
    }
  }

  const pnpm = pnpmCommand(execPath);

  if (pnpm === null) {
    throw new PreflightError(
      [
        'Could not locate corepack or a pnpm shim next to the running node binary.',
        `Looked for "corepack", "pnpm", and "pnpm.cjs" in ${path.dirname(execPath)}.`,
        'Install pnpm or enable corepack (`corepack enable`) so the pinned version resolves.',
      ].join('\n'),
    );
  }

  return { source: 'node-shim', ...pnpm, corepackVersion: null };
}

export function probePnpmVersion(launcher, { cwd, env = stepEnvironment() }) {
  const { executable, args } = spawnCommand(launcher, ['--version']);
  const display = displayCommand(launcher, ['--version']);
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8' });

  if (result.error) {
    throw new PreflightError(
      [
        `Could not run "${display}": ${result.error.message}`,
        'Install pnpm or enable corepack (`corepack enable`) so the pinned version resolves.',
      ].join('\n'),
    );
  }

  if (result.status !== 0) {
    throw new PreflightError(
      `"${display}" failed with exit ${result.status ?? 'unknown'}.\n${(result.stderr ?? '').trim()}`,
    );
  }

  const lines = (result.stdout ?? '').trim().split('\n');

  return (lines.at(-1) ?? '').trim();
}

export function assertPnpmVersion(launcher, actualVersion, pinnedVersion) {
  if (actualVersion === pinnedVersion) {
    return;
  }

  const hint =
    launcher.source === 'corepack'
      ? 'Run `corepack install`/`corepack enable` so the pinned pnpm is available, then re-run.'
      : 'Enable corepack (`corepack enable`) so the pinned pnpm version is used instead of the node-local pnpm shim.';

  throw new PreflightError(
    [
      `pnpm version mismatch: package.json pins pnpm@${pinnedVersion} but ${launcher.source} resolved "${actualVersion || '<empty>'}".`,
      hint,
    ].join('\n'),
  );
}

export function measureDirectory(directory, entryLimit = 200000) {
  let entries = 0;
  let bytes = 0;
  const stack = [directory];

  while (stack.length > 0 && entries < entryLimit) {
    const current = stack.pop();
    let dirents;

    try {
      dirents = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      entries += 1;
      const fullPath = path.join(current, dirent.name);

      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        try {
          bytes += statSync(fullPath).size;
        } catch {
          // An unreadable file still counts as an entry; size is best effort.
        }
      }
    }
  }

  return { entries, bytes };
}

/** Deterministic, locale-independent ordering (UTF-16 code unit order). */
export function compareCodeUnits(left, right) {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

export function snapshotRepoShape(repoRoot = REPO_ROOT) {
  return {
    root: readdirSync(repoRoot).sort(compareCodeUnits),
    scripts: listRelative(repoRoot, 'scripts'),
  };
}

function listRelative(root, startRelative) {
  const start = path.join(root, startRelative);

  if (!existsSync(start)) {
    return [];
  }

  const found = [];
  const stack = [''];

  while (stack.length > 0) {
    const relative = stack.pop();
    const current = path.join(start, relative);

    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const next = path.join(relative, dirent.name);
      found.push(next);

      if (dirent.isDirectory()) {
        stack.push(next);
      }
    }
  }

  return found.sort(compareCodeUnits);
}

export function gitHead(sourceRoot, env = stepEnvironment()) {
  const result = spawnSync(resolveSystemTool('git'), ['rev-parse', 'HEAD'], {
    cwd: sourceRoot,
    env,
    encoding: 'utf8',
  });

  if (result.error || result.status !== 0) {
    throw new PreflightError(
      `Could not read HEAD from ${sourceRoot}: ${result.error?.message ?? (result.stderr ?? '').trim()}`,
    );
  }

  return result.stdout.trim();
}

export function extractTree({ sourceRoot, archiveFile, destDir, env = stepEnvironment() }) {
  mkdirSync(destDir, { recursive: true });

  let input;
  let source;
  let commit = null;

  if (archiveFile) {
    const absolute = path.resolve(archiveFile);

    if (!existsSync(absolute)) {
      throw new PreflightError(`Archive not found: ${absolute}`);
    }

    input = readFileSync(absolute);
    source = `archive ${absolute}`;
  } else {
    commit = gitHead(sourceRoot, env);
    const archive = spawnSync(resolveSystemTool('git'), ['archive', '--format=tar', 'HEAD'], {
      cwd: sourceRoot,
      env,
      maxBuffer: 1024 ** 3,
    });

    if (archive.error) {
      throw new PreflightError(`Could not run git archive: ${archive.error.message}`);
    }

    if (archive.status !== 0) {
      throw new PreflightError(
        `git archive HEAD failed with exit ${archive.status}. ${(archive.stderr ?? '').toString().trim()}`,
      );
    }

    input = archive.stdout;
    source = `git archive HEAD (${commit.slice(0, 12)})`;
  }

  const tar = spawnSync(resolveSystemTool('tar'), ['-x', '-C', destDir], {
    input,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (tar.error) {
    throw new PreflightError(`Could not run tar: ${tar.error.message}`);
  }

  if (tar.status !== 0) {
    throw new PreflightError(
      `tar extraction failed with exit ${tar.status}. ${(tar.stderr ?? '').toString().trim()}`,
    );
  }

  if (!existsSync(path.join(destDir, 'package.json'))) {
    throw new PreflightError('The archive does not contain package.json at its root.');
  }

  return { source, commit, archiveBytes: input.byteLength };
}

/**
 * Runs one command, streaming output live while retaining a bounded tail so a
 * failure can still be summarized after the fact.
 */
export function runStep({ label, command, args, cwd, env, display }) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let tail = '';
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve({ ...result, durationMs: Date.now() - startedAt, tail });
    };

    log(`${label} started: ${display ?? [command, ...args].join(' ')}`);

    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });

    const record = (chunk) => {
      tail = `${tail}${chunk}`.slice(-TAIL_LIMIT);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      record(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      record(chunk);
    });
    child.on('error', (error) => finish({ ok: false, status: null, signal: null, error }));
    child.on('close', (status, signal) =>
      finish({ ok: status === 0, status, signal, error: null }),
    );
  });
}

function describeFailureReason(result) {
  if (result.error) {
    return `could not start: ${result.error.message}`;
  }

  const status = result.status ?? 'unknown';

  if (result.signal) {
    return `exit ${status} (signal ${result.signal})`;
  }

  return `exit ${status}`;
}

export function formatRunFailure(label, result, commandDisplay) {
  const reason = describeFailureReason(result);

  return `${label} failed (${reason}) after ${formatDuration(result.durationMs)} — ${commandDisplay}`;
}

function printPlan({ sourceRoot, options, pin, nodePin }) {
  const tempRoot = path.resolve(options.tempRoot ?? tmpdir());
  const plannedTemp = path.join(tempRoot, `${TEMP_PREFIX}XXXXXX`);
  const archiveStep = options.archive
    ? `extract ${path.resolve(options.archive)}`
    : 'git archive HEAD';

  console.log('[clean-install] plan (dry run: nothing is installed, extracted, or written)');
  console.log(`  source       ${sourceRoot}`);
  console.log(`  temp root    ${tempRoot}`);
  console.log(`  temp tree    ${plannedTemp} (outside the repository, removed on exit)`);
  console.log(
    `  pinned       node ${nodePin ?? '<unpinned>'} · pnpm ${pin.version} (${pin.field})`,
  );
  console.log(`  steps        ${STEP_NAMES.join(' → ')}`);
  console.log(`  1. archive   ${archiveStep} → <temp>/tree (HEAD snapshot only)`);
  console.log(
    '  2. preflight exactly one lockfile (pnpm-lock.yaml) · pnpm version matches packageManager · store must not exist yet',
  );
  console.log(
    '  3. install   pnpm install --frozen-lockfile --store-dir <temp>/store (cold store)',
  );
  console.log('  4. build     pnpm build');
  console.log('  5. typecheck pnpm typecheck');
  console.log('  6. test      pnpm test');
  console.log('[clean-install] dry run complete: no files written, exit 0.');
}

function removeTempDir(tempDir, keep) {
  if (!existsSync(tempDir)) {
    return { removed: false, kept: false };
  }

  if (keep) {
    return { removed: false, kept: true };
  }

  rmSync(tempDir, { recursive: true, force: true, maxRetries: 5 });

  if (existsSync(tempDir)) {
    throw new Error(`Temp directory still exists after cleanup: ${tempDir}`);
  }

  return { removed: true, kept: false };
}

function describePnpmSource(pnpm) {
  const corepackNote = pnpm.corepackVersion ? ` (corepack ${pnpm.corepackVersion})` : '';

  return `  pnpm            ${pnpm.version} via ${pnpm.source}${corepackNote}`;
}

function printEvidence(evidence) {
  const stepSummary = evidence.steps
    .map((entry) => `${entry.label} ${formatDuration(entry.durationMs)}`)
    .join(' | ');

  log('evidence');
  console.log(`  commit          ${evidence.commit ?? '<archive override>'}`);
  console.log(`  node            v${process.versions.node} (expected ${evidence.nodePin ?? 'unpinned'})`);
  console.log(describePnpmSource(evidence.pnpm));
  console.log(
    `  lockfile        ${evidence.lockfile.name} sha256=${evidence.lockfile.sha256} bytes=${evidence.lockfile.bytes}`,
  );
  console.log(`  install source  cold store ${evidence.store.dir} (absent before install)`);
  console.log(
    `  store contents  ${evidence.store.entries} entries, ${(evidence.store.bytes / (1024 * 1024)).toFixed(1)} MiB`,
  );
  console.log(`  archive         ${evidence.archive.source} (${evidence.archive.archiveBytes} bytes)`);
  console.log(`  steps           ${stepSummary}`);
  console.log(`  total           ${formatDuration(evidence.totalMs)}`);
}

function describeNodePin(nodePin) {
  if (nodePin === null) {
    return ' (no .node-version pin)';
  }

  if (nodePin === process.versions.node) {
    return ` (matches .node-version ${nodePin})`;
  }

  return ` (WARN: .node-version pins ${nodePin})`;
}

function logRunContext(run) {
  const origin = run.options.archive
    ? ` (archive ${run.options.archive})`
    : ' (git archive HEAD)';

  log(`temp tree ${run.tempDir}`);
  log(`source ${run.sourceRoot}${origin}`);
  log(`node v${process.versions.node}${describeNodePin(run.nodePin)}`);
}

/** Creates the isolated temp tree, which lives outside the repository. */
function startRun({ options, repoRoot, sourceRoot, nodePin }) {
  const tempRoot = path.resolve(options.tempRoot ?? tmpdir());

  assertOutsideRepo(tempRoot, repoRoot);
  mkdirSync(tempRoot, { recursive: true });

  const tempDir = mkdtempSync(path.join(tempRoot, TEMP_PREFIX));
  const run = {
    options,
    sourceRoot,
    nodePin,
    tempDir,
    treeDir: path.join(tempDir, 'tree'),
    storeDir: path.join(tempDir, 'store'),
    env: stepEnvironment(),
    steps: [],
    startedAt: Date.now(),
  };

  assertOutsideRepo(tempDir, repoRoot);
  logRunContext(run);

  return run;
}

function archiveStep(run) {
  const startedAt = Date.now();
  const archive = extractTree({
    sourceRoot: run.sourceRoot,
    archiveFile: run.options.archive,
    destDir: run.treeDir,
    env: run.env,
  });
  const durationMs = Date.now() - startedAt;

  run.steps.push({ label: 'archive', durationMs });
  log(`archive ok in ${formatDuration(durationMs)} (${archive.source})`);

  return archive;
}

function assertColdStore(storeDir) {
  if (!existsSync(storeDir)) {
    return;
  }

  throw new PreflightError(`Isolated store already exists, refusing to call it cold: ${storeDir}`);
}

function preflightStep(run) {
  const startedAt = Date.now();
  const lockfile = inspectLockfiles(run.treeDir);
  const pin = readPackageManagerPin(path.join(run.treeDir, 'package.json'));
  const launcher = detectPnpmLauncher({ cwd: run.treeDir, env: run.env });
  const pnpmVersion = probePnpmVersion(launcher, { cwd: run.treeDir, env: run.env });

  assertPnpmVersion(launcher, pnpmVersion, pin.version);
  assertColdStore(run.storeDir);

  const durationMs = Date.now() - startedAt;

  log(
    `preflight ok in ${formatDuration(durationMs)} (${lockfile.name} sha256=${lockfile.sha256.slice(0, 12)}…, pnpm ${pnpmVersion} via ${launcher.source}, cold store)`,
  );

  return { lockfile, launcher, pnpmVersion };
}

function planSteps(launcher, storeDir) {
  const withLauncher = (args) => spawnCommand(launcher, args).args;

  return [
    {
      label: 'install',
      args: withLauncher(['install', '--frozen-lockfile', '--store-dir', storeDir]),
      display: `pnpm install --frozen-lockfile --store-dir ${storeDir}`,
    },
    { label: 'build', args: withLauncher(['build']) },
    { label: 'typecheck', args: withLauncher(['typecheck']) },
    { label: 'test', args: withLauncher(['test']) },
  ];
}

/** Puts the private toolchain shims on the child PATH for the install steps. */
function addToolShimsToPath(run, launcher) {
  const { binDir } = writeToolShims(path.join(run.tempDir, 'bin'), launcher);

  run.env.PATH = [binDir, childPath()].filter(Boolean).join(path.delimiter);
  log(`toolchain shims ${binDir}`);
}

function throwStepFailure(launcher, step, result) {
  const display = step.display ?? [launcher.executable, ...step.args].join(' ');
  const message = formatRunFailure(step.label, result, display);

  logError(message);

  if (result.tail.trim()) {
    logError(`${step.label} last output:`);
    console.error(result.tail.trimEnd());
  }

  throw new StepFailedError(message);
}

async function executeStep(run, launcher, step) {
  const result = await runStep({
    label: step.label,
    command: launcher.executable,
    args: step.args,
    cwd: run.treeDir,
    env: run.env,
    display: step.display,
  });

  if (!result.ok) {
    throwStepFailure(launcher, step, result);
  }

  run.steps.push({ label: step.label, durationMs: result.durationMs });
  log(`${step.label} ok in ${formatDuration(result.durationMs)}`);
}

async function executeRun(run) {
  const archive = archiveStep(run);
  const { lockfile, launcher, pnpmVersion } = preflightStep(run);

  addToolShimsToPath(run, launcher);

  for (const step of planSteps(launcher, run.storeDir)) {
    await executeStep(run, launcher, step);
  }

  const store = { dir: run.storeDir, ...measureDirectory(run.storeDir) };

  printEvidence({
    commit: archive.commit,
    nodePin: run.nodePin,
    pnpm: {
      version: pnpmVersion,
      source: launcher.source,
      corepackVersion: launcher.corepackVersion,
    },
    lockfile,
    store,
    archive,
    steps: run.steps,
    totalMs: Date.now() - run.startedAt,
  });
  log('PASS: cold install, build, typecheck, and tests succeeded from git archive HEAD.');
}

/** Cleans up the temp tree; returns the cleanup error, if any. */
function reportCleanup(tempDir, keep) {
  try {
    const cleanup = removeTempDir(tempDir, keep);

    if (cleanup.kept) {
      log(`temp tree kept at ${tempDir}`);
    } else if (cleanup.removed) {
      log('temp tree removed');
    }

    return null;
  } catch (error) {
    logError(error.message);

    return error;
  }
}

export function stringifyForLog(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const json = JSON.stringify(value);

    if (typeof json === 'string') {
      return json;
    }

    return Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function describeFailure(failure) {
  if (failure instanceof Error) {
    return failure.stack ?? failure.message;
  }

  return stringifyForLog(failure);
}

function exitCodeForFailure(failure, startedAt) {
  if (!failure) {
    return EXIT_OK;
  }

  if (failure instanceof StepFailedError) {
    logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

    return EXIT_STEP_FAILED;
  }

  if (failure instanceof PreflightError || failure instanceof UsageError) {
    logError(failure.message);
    logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

    return EXIT_USAGE;
  }

  logError(describeFailure(failure));
  logError(`FAIL after ${formatDuration(Date.now() - startedAt)}`);

  return EXIT_STEP_FAILED;
}

async function runColdInstall({ options, repoRoot, sourceRoot, nodePin }) {
  const run = startRun({ options, repoRoot, sourceRoot, nodePin });
  let failure = null;

  try {
    await executeRun(run);
  } catch (error) {
    failure = error;
  } finally {
    const cleanupError = reportCleanup(run.tempDir, options.keep);

    failure ??= cleanupError;
  }

  return exitCodeForFailure(failure, run.startedAt);
}

export async function main(argv = process.argv.slice(2), repoRoot = REPO_ROOT) {
  const options = parseArgs(argv);

  if (options.help) {
    printUsage();

    return EXIT_OK;
  }

  const sourceRoot = path.resolve(options.source ?? repoRoot);
  const nodePin = readNodeVersionPin(sourceRoot);

  if (options.dryRun) {
    printPlan({
      sourceRoot,
      options,
      pin: readPackageManagerPin(path.join(sourceRoot, 'package.json')),
      nodePin,
    });

    return EXIT_OK;
  }

  return runColdInstall({ options, repoRoot, sourceRoot, nodePin });
}

const invokedDirectly =
  process.argv.length > 1 && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH);

if (invokedDirectly) {
  try {
    process.exitCode = await main();
  } catch (error) {
    logError(error instanceof UsageError ? error.message : describeFailure(error));
    process.exitCode = error instanceof UsageError ? EXIT_USAGE : EXIT_STEP_FAILED;
  }
}
