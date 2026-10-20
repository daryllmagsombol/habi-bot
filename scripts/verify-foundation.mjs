#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  FORCED_TEST_ARGS,
  SANITIZED_BUILD_ARGS,
  assertNoDevDependency,
  assertTaskDependency,
  findForbiddenDotenvFiles,
  formatForbiddenDotenvMessage,
  resolveRoot,
  sanitizedEnvironment,
} from './verify-foundation-lib.mjs';

const ROOT = resolveRoot(import.meta.url);

if (process.argv.includes('--clean-install')) {
  console.error(
    'Refusing destructive --clean-install: this runner verifies the installed workspace in place.',
  );
  process.exit(2);
}

function run(label, command, args, options = {}) {
  console.log(`\n[verify] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: options.env ?? process.env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    console.error(`[verify] ${label} failed with exit ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }
}

function readJson(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    console.error(result.stderr.trim());
    console.error(`[verify] ${label} failed with exit ${result.status ?? 'unknown'}`);
    process.exit(result.status ?? 1);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    console.error(`[verify] ${label} did not return valid JSON.`);
    console.error(result.stdout.slice(0, 1000));
    throw error;
  }
}

const forbiddenDotenvFiles = findForbiddenDotenvFiles(ROOT);

if (forbiddenDotenvFiles.length > 0) {
  console.error(formatForbiddenDotenvMessage(forbiddenDotenvFiles));
  process.exit(2);
}

run('frozen install', 'pnpm', ['install', '--frozen-lockfile']);
run('focused verification tests', 'node', [
  '--test',
  'scripts/verify-foundation.test.mjs',
]);
run('sanitized forced build', 'pnpm', SANITIZED_BUILD_ARGS, {
  env: sanitizedEnvironment(),
});

for (const relativePath of [
  'packages/contracts/dist/index.js',
  'packages/contracts/dist/index.d.ts',
  'apps/backend/dist/main.js',
  'apps/backend/dist/worker.js',
  'apps/web/.next/BUILD_ID',
]) {
  if (!existsSync(path.join(ROOT, relativePath))) {
    throw new Error(`Expected build artifact missing: ${relativePath}`);
  }
}

run('typecheck', 'pnpm', ['typecheck']);
run('lint', 'pnpm', ['lint']);
run('forced tests', 'pnpm', FORCED_TEST_ARGS);

const buildGraph = readJson('build graph', 'pnpm', [
  'exec',
  'turbo',
  'run',
  'build',
  '--dry=json',
]);

assertTaskDependency(buildGraph, '@habi/backend#build', '@habi/contracts#build');

const devGraph = readJson('dev graph', 'pnpm', [
  'exec',
  'turbo',
  'run',
  'dev',
  '--dry=json',
]);

assertTaskDependency(devGraph, '@habi/backend#dev', '@habi/contracts#build');
assertNoDevDependency(devGraph);

console.log('\n[verify] Foundation verification passed (fresh forced build + forced tests).');
