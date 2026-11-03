import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import process from 'node:process';
import {
  EXIT_FINDINGS,
  EXIT_OK,
  EXIT_USAGE,
  SCRIPT_PATH,
  isBinaryContent,
  isDotEnvFile,
  isPlaceholderValue,
  isTestFixturePath,
  isVariableReference,
  parseArgs,
  scanRepository,
  scanText,
} from './release-secret-scan.mjs';

const NODE = process.execPath;

function tempDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function runScript(args, options = {}) {
  return spawnSync(NODE, [SCRIPT_PATH, ...args], {
    cwd: options.cwd ?? path.dirname(SCRIPT_PATH),
    encoding: 'utf8',
  });
}

function makeRepo(files) {
  const dir = tempDir('habi secret scan fixture ');
  const git = (args) =>
    spawnSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
      },
    });

  assert.equal(git(['init', '-q']).status, 0);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(dir, relativePath);
    writeFileSync(absolutePath, content, { flag: 'w' });
  }
  assert.equal(git(['add', '-A']).status, 0);
  return dir;
}

test('parseArgs defaults to the repository root and rejects unknown input', () => {
  const options = parseArgs([]);
  assert.equal(options.maxBytes, 1_048_576);
  assert.match(options.root, /habi-bot$/);

  assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
  assert.throws(() => parseArgs(['--root']), /requires a directory/);
  assert.throws(() => parseArgs(['--max-bytes', '0']), /positive integer/);
});

test('classifies environment files while allowing the documented example', () => {
  assert.equal(isDotEnvFile('.env'), true);
  assert.equal(isDotEnvFile('apps/web/.env'), true);
  assert.equal(isDotEnvFile('.env.local'), true);
  assert.equal(isDotEnvFile('.env.production'), true);
  assert.equal(isDotEnvFile('.env.example'), false);
  assert.equal(isDotEnvFile('config/environment.ts'), false);
});

test('detects binary content from a leading NUL byte only', () => {
  assert.equal(isBinaryContent(Buffer.from('plain text')), false);
  assert.equal(isBinaryContent(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false);
  assert.equal(isBinaryContent(Buffer.from([0x41, 0x00, 0x42])), true);
});

test('recognises placeholders and variable references', () => {
  for (const value of [
    'replace-with-a-local-only-password',
    'changeme-changeme-changeme',
    'example-token-value',
    'your-api-key-here',
    '<insert-secret>',
    '${SOME_SECRET}',
    'xxxxxxxxxxxxxxxx',
  ]) {
    assert.equal(isPlaceholderValue(value), true, value);
  }
  assert.equal(isPlaceholderValue('a8f5f167f44f4964e6c998dee827110c'), false);

  for (const value of [
    'process.env.GITHUB_TOKEN',
    'env.GITHUB_TOKEN',
    'SOME_CONSTANT_TOKEN',
    'normalizedTokens',
  ]) {
    assert.equal(isVariableReference(value), true, value);
  }
  assert.equal(isVariableReference('sup3r-s3cret-local-password'), false);
});

test('classifies test fixture paths for the generic assignment rule', () => {
  assert.equal(isTestFixturePath('packages/config/test/env.test.mjs'), true);
  assert.equal(isTestFixturePath('scripts/ci/release-secret-scan.test.mjs'), true);
  assert.equal(isTestFixturePath('scripts/ci/fixtures/values.json'), true);
  assert.equal(isTestFixturePath('scripts/ci/release-secret-scan.mjs'), false);
});

test('scanText reports provider patterns without echoing the value', () => {
  const awsKey = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const githubToken = `ghp_${'a'.repeat(36)}`;
  const text = [
    `const config = { key: "${awsKey}" };`,
    `const remote = "https://x-access-token:${githubToken}@github.com";`,
  ].join('\n');

  const findings = scanText('src/config.ts', text);
  assert.deepEqual(
    findings.map((finding) => `${finding.rule}:${finding.line}`),
    ['aws-access-key-id:1', 'github-token:2'],
  );
  assert.equal(JSON.stringify(findings).includes(awsKey), false);
});

test('scanText flags a literal assigned credential outside test fixtures', () => {
  const findings = scanText('src/settings.ts', 'const apiKey = "a8f5f167f44f4964e6c998dee827110c";\n');
  assert.deepEqual(findings, [{ rule: 'assigned-credential', path: 'src/settings.ts', line: 1 }]);
});

test('scanText ignores test fixtures, references, and placeholders', () => {
  const fixture = 'const secret = "sup3r-s3cret-local-password";\n';
  assert.deepEqual(scanText('packages/config/test/env.test.mjs', fixture), []);
  assert.deepEqual(scanText('src/settings.ts', 'token: process.env.GITHUB_TOKEN,\n'), []);
  assert.deepEqual(scanText('src/settings.ts', 'POSTGRES_PASSWORD=replace-with-a-local-only-password\n'), []);
});

test('scanRepository uses git tracked files only and skips binaries', () => {
  const repo = makeRepo({
    'README.md': 'clean\n',
    '.env.example': 'POSTGRES_PASSWORD=replace-with-a-local-only-password\n',
    'image.bin': `AKIA${'IOSFODNN7EXAMPLE'}\u0000binary`,
    'untracked.txt': `AKIA${'IOSFODNN7EXAMPLE'}\n`,
  });
  try {
    spawnSync('git', ['-C', repo, 'rm', '--cached', '-q', 'untracked.txt'], { encoding: 'utf8' });
    const result = scanRepository(repo);
    assert.deepEqual(result.findings, []);
    assert.equal(result.trackedCount, 3);
    assert.deepEqual(
      result.skipped.map((entry) => `${entry.path}:${entry.reason}`),
      ['image.bin:binary'],
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('scanRepository flags a tracked .env file', () => {
  const repo = makeRepo({ 'README.md': 'clean\n', '.env': 'POSTGRES_PASSWORD=local-only\n' });
  try {
    const result = scanRepository(repo);
    assert.deepEqual(result.findings, [{ rule: 'dotenv-file', path: '.env', line: 1 }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI exits 0 on a clean repository', () => {
  const repo = makeRepo({ 'README.md': 'clean\n', '.env.example': 'POSTGRES_DB=habi\n' });
  try {
    const result = runScript(['--root', repo]);
    assert.equal(result.status, EXIT_OK, result.stderr);
    assert.match(result.stdout, /scanned 2\/2 tracked file\(s\), 0 finding\(s\)/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI exits 1 on a finding and keeps the secret out of its output', () => {
  const awsKey = `AKIA${'IOSFODNN7EXAMPLE'}`;
  const repo = makeRepo({ 'config.ts': `export const key = "${awsKey}";\n` });
  try {
    const result = runScript(['--root', repo]);
    assert.equal(result.status, EXIT_FINDINGS, result.stderr);
    assert.match(result.stdout, /rule=aws-access-key-id file=config\.ts:1/);
    assert.equal(result.stdout.includes(awsKey), false);
    assert.equal(result.stderr.includes(awsKey), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI exits 2 outside a git repository and for usage errors', () => {
  const dir = tempDir('habi secret scan ungoverned ');
  try {
    const notRepo = runScript(['--root', dir]);
    assert.equal(notRepo.status, EXIT_USAGE);
    assert.match(notRepo.stderr, /git ls-files failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const usage = runScript(['--bogus']);
  assert.equal(usage.status, EXIT_USAGE);
  assert.match(usage.stderr, /Unknown argument/);

  const help = runScript(['--help']);
  assert.equal(help.status, EXIT_OK);
  assert.match(help.stdout, /Scans files tracked by git/);
});
