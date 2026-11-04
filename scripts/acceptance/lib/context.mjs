/**
 * Acceptance context: one disposable PostgreSQL container, the real compiled
 * backend, shared fixtures, an in-process P1 API, and an optional worker.
 *
 * Nothing here deploys, contacts a provider, or writes to a developer database.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BACKEND_ROOT,
  REPOSITORY_ROOT,
  captureOutput,
  requireBackendModule,
  run,
  stopChild,
  waitForLogEvent,
} from './process.mjs';
import {
  applyMigrations,
  dockerAvailable,
  dockerServerVersion,
  postgresClientAvailable,
  postgresImageDigest,
  startPostgres,
} from './docker.mjs';
import { createHermesStub } from './hermes-stub.mjs';
import { seedWorld } from './seed.mjs';

const dist = (name) => pathToFileURL(join(BACKEND_ROOT, 'dist', name)).href;

const CONFIG_KEYS = [
  'DATABASE_URL',
  'NODE_ENV',
  'HABI_P1_API',
  'HABI_P1_API_SSE_HEARTBEAT_MS',
  'HABI_P1_WORKER',
  'HABI_AUTH_SPIKE',
  'HABI_REGISTRATION_MODE',
  'HABI_HERMES_BASE_URL',
  'HABI_HERMES_GATEWAY_KEY',
  'HABI_HERMES_REQUEST_TIMEOUT_MS',
  'HABI_HERMES_EVENT_IDLE_TIMEOUT_MS',
  'HABI_WORKER_CONCURRENCY',
  'HABI_WORKER_LEASE_MS',
  'HABI_WORKER_DRAIN_MS',
  'HABI_SSO_GOOGLE_CLIENT_ID',
  'HABI_SSO_GOOGLE_CLIENT_SECRET',
  'HABI_SSO_GOOGLE_REDIRECT_URI',
  'HABI_SSO_MICROSOFT_CLIENT_ID',
  'HABI_SSO_MICROSOFT_CLIENT_SECRET',
  'HABI_SSO_MICROSOFT_REDIRECT_URI',
  'HABI_SSO_MICROSOFT_ISSUER',
  'HABI_SSO_FACEBOOK_CLIENT_ID',
  'HABI_SSO_FACEBOOK_CLIENT_SECRET',
  'HABI_SSO_FACEBOOK_REDIRECT_URI',
  'HABI_ACCEPTANCE_VM_HOST',
];

function configPresence(env) {
  const result = {};

  for (const key of CONFIG_KEYS) {
    const value = env[key];
    result[key] =
      value === undefined || value.trim() === ''
        ? 'absent'
        : 'present (value not recorded)';
  }

  return result;
}

function git(argument) {
  const result = run('git', argument, { timeoutMs: 10_000 });

  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

export async function createContext({ outDir, keep = false } = {}) {
  const frozenEnv = { ...process.env };
  const dockerReady = dockerAvailable();

  if (dockerReady !== true) {
    return {
      dockerReady: false,
      environment: {
        repoCommit: git(['rev-parse', 'HEAD']),
        worktreeDirty: git(['status', '--porcelain']).length > 0 ? 'yes' : 'no',
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        docker: 'unavailable',
        postgresImage: 'postgres:18.6-alpine (not started)',
        postgresImageDigest: 'unavailable',
        configKeys: configPresence(frozenEnv),
        reportDirectory: outDir ?? 'not created',
      },
      async teardown() {},
    };
  }

  const postgres = await startPostgres();

  // Last-resort cleanup: an uncaught error or signal must not leave the
  // disposable container behind. Normal teardown already removes it; `rm -f`
  // is a no-op then.
  if (keep !== true) {
    process.once('exit', () => {
      run('docker', ['rm', '-f', postgres.containerName], { timeoutMs: 15_000 });
    });
  }

  let migrations;

  try {
    migrations = applyMigrations(postgres.url);
  } catch (error) {
    await postgres.stop();
    throw error;
  }

  const pool = postgres.pool;
  const storageRoot = await mkdtemp(join(tmpdir(), 'habi-acceptance-files-'));

  const context = {
    dockerReady: true,
    postgres,
    pool,
    migrations,
    storageRoot,
    p1: null,
    worker: null,
    hermes: null,
    world: null,
    environment: {
      repoCommit: git(['rev-parse', 'HEAD']),
      worktreeDirty: git(['status', '--porcelain']).length > 0 ? 'yes' : 'no',
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      docker: dockerServerVersion(),
      postgresImage: 'postgres:18.6-alpine',
      postgresImageDigest: postgresImageDigest(),
      postgresHost: '127.0.0.1 (ephemeral container)',
      migrationsApplied: String(migrations.applied),
      pgClientTools: postgresClientAvailable() ? 'present' : 'absent',
      configKeys: configPresence(frozenEnv),
      reportDirectory: outDir ?? 'not created',
    },

    async ensureWorld() {
      if (this.world === null) {
        this.world = await seedWorld(pool);
      }

      return this.world;
    },

    /**
     * Boots the real Nest app in-process with only the P1 chat flag. The auth
     * surface is exercised in a separate child process because each module owns
     * its own in-memory SessionService and AppModule decides flags at import.
     */
    async ensureP1() {
      if (this.p1 !== null) {
        return this.p1;
      }

      for (const name of [
        'HABI_SPIKE_MODE',
        'HABI_SESSION_SPIKE',
        'HABI_SESSION_SPIKE_TEST_CLOCK',
        'HABI_AUTH_SPIKE',
      ]) {
        delete process.env[name];
      }

      process.env.NODE_ENV = 'test';
      process.env.HABI_P1_API = '1';
      process.env.HABI_P1_API_SSE_HEARTBEAT_MS = '300';
      process.env.DATABASE_URL = postgres.url;

      const { NestFactory } = requireBackendModule('@nestjs/core');
      const { AppModule } = await import(dist('app.module.js'));
      const { SessionService } = await import(dist('session/session.service.js'));
      const app = await NestFactory.create(AppModule, { logger: false });

      await app.listen(0, '127.0.0.1');

      const address = app.getHttpServer().address();

      if (address === null || typeof address === 'string') {
        await app.close();
        throw new Error('In-process API did not bind a TCP port.');
      }

      const sessions = app.get(SessionService);

      this.p1 = {
        app,
        base: `http://127.0.0.1:${address.port}`,
        sessions,
        sessionFor(userId) {
          const issued = sessions.create(userId);

          return {
            cookie: `habi_session=${issued.sessionId}`,
            csrfToken: issued.csrfToken,
          };
        },
      };

      return this.p1;
    },

    async ensureHermes() {
      if (this.hermes === null) {
        this.hermes = await createHermesStub();
      }

      return this.hermes;
    },

    /**
     * Starts the real compiled worker against the local Hermes stub. A worker
     * is single-use in a scenario: callers stop it before changing its env.
     */
    async startWorker({ requestTimeoutMs, eventIdleTimeoutMs, extraEnv = {} } = {}) {
      const hermes = await this.ensureHermes();
      const env = { ...process.env };

      for (const name of [
        'HABI_SPIKE_MODE',
        'HABI_SESSION_SPIKE',
        'HABI_AUTH_SPIKE',
        'HABI_P1_API',
        'HABI_HERMES_BASE_URL',
        'HABI_HERMES_GATEWAY_KEY',
        'HABI_HERMES_REQUEST_TIMEOUT_MS',
        'HABI_HERMES_EVENT_IDLE_TIMEOUT_MS',
      ]) {
        delete env[name];
      }

      const child = (await import('node:child_process')).spawn(
        process.execPath,
        [join(BACKEND_ROOT, 'dist/worker.js')],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...env,
            NODE_ENV: 'test',
            DATABASE_URL: postgres.url,
            HABI_P1_WORKER: '1',
            HABI_HERMES_BASE_URL: hermes.url,
            HABI_HERMES_GATEWAY_KEY: randomBytes(24).toString('hex'),
            ...(requestTimeoutMs === undefined
              ? {}
              : { HABI_HERMES_REQUEST_TIMEOUT_MS: String(requestTimeoutMs) }),
            ...(eventIdleTimeoutMs === undefined
              ? {}
              : { HABI_HERMES_EVENT_IDLE_TIMEOUT_MS: String(eventIdleTimeoutMs) }),
            HABI_WORKER_CONCURRENCY: '1',
            HABI_WORKER_BATCH_SIZE: '1',
            HABI_WORKER_IDLE_BACKOFF_MS: '25',
            HABI_WORKER_MAX_IDLE_BACKOFF_MS: '100',
            HABI_WORKER_LEASE_MS: '800',
            HABI_WORKER_DRAIN_MS: '200',
            HABI_WORKER_RECOVERY_LIMIT: '50',
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const output = captureOutput(child);

      try {
        await waitForLogEvent(child, output, 'worker.ready', 25_000);
      } catch (error) {
        await stopChild(child);
        throw error;
      }

      this.worker = { child, output };
      return this.worker;
    },

    async stopWorker(signal = 'SIGTERM') {
      if (this.worker !== null) {
        const current = this.worker;
        this.worker = null;
        await stopChild(current.child, { signal });
      }
    },

    async teardown() {
      await this.stopWorker('SIGKILL').catch(() => {});

      if (this.hermes !== null) {
        await this.hermes.close().catch(() => {});
        this.hermes = null;
      }

      if (this.p1 !== null) {
        await this.p1.app.close().catch(() => {});
        this.p1 = null;
      }

      await rm(storageRoot, { recursive: true, force: true }).catch(() => {});
      await postgres.stop();
    },
  };

  return context;
}
