import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIRS = ['apps/backend', 'apps/web'];
export const APP_DOTENV_ALLOWLIST = new Set(['.env.example']);
export const NORMAL_BUILD_ARGS = ['build'];
export const SANITIZED_BUILD_ARGS = ['exec', 'turbo', 'run', 'build', '--force'];
export const FORCED_TEST_ARGS = ['exec', 'turbo', 'run', 'test', '--force'];
export const SECRET_ENV =
  /^(?:DATABASE_URL|POSTGRES_|OPENAI_|OPENCODE_|HERMES_|AWS_|GITHUB_)|(?:_KEY|_TOKEN|_SECRET)$/;

export function resolveRoot(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..');
}

export function findForbiddenDotenvFiles(root, appDirs = APP_DIRS) {
  const found = [];

  for (const appDir of appDirs) {
    let entries;

    try {
      entries = readdirSync(path.join(root, appDir), { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.name.startsWith('.env') || APP_DOTENV_ALLOWLIST.has(entry.name)) {
        continue;
      }

      if (entry.isFile() || entry.isSymbolicLink()) {
        found.push(path.join(appDir, entry.name));
      }
    }
  }

  return found.sort();
}

export function formatForbiddenDotenvMessage(files) {
  return [
    'Application dotenv files are not allowed for verification:',
    ...files.map((file) => `  - ${file}`),
    'Remove or rename them locally before running verification. The runner does not read, move, or delete them.',
    'Root .env is allowed for local Compose.',
  ].join('\n');
}

export function sanitizedEnvironment(sourceEnv = process.env) {
  const env = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined || SECRET_ENV.test(key)) {
      continue;
    }

    env[key] = value;
  }

  return env;
}

export function taskMap(graph) {
  return new Map((graph.tasks ?? []).map((task) => [task.taskId, task]));
}

export function assertTaskDependency(graph, taskId, dependencyId) {
  const task = taskMap(graph).get(taskId);

  if (!task) {
    throw new Error(`Expected task ${taskId} in the Turbo graph.`);
  }

  if (!task.dependencies.includes(dependencyId)) {
    throw new Error(
      `Expected ${taskId} to depend on ${dependencyId}; found ${JSON.stringify(task.dependencies)}.`,
    );
  }
}

export function assertNoDevDependency(graph) {
  for (const task of graph.tasks ?? []) {
    if (
      task.taskId.endsWith('#dev') &&
      task.dependencies.some((dependency) => dependency.endsWith('#dev'))
    ) {
      throw new Error(`Persistent dev task ${task.taskId} must not depend on another dev task.`);
    }
  }
}
