/**
 * Environment-driven worker runtime.
 *
 * Only reached through the dynamic import in `worker.module.ts`, which is
 * selected by `HABI_P1_WORKER=1`. When the flag is unset, no file in this
 * directory is loaded: the worker process keeps its original inert shape.
 *
 * The Hermes adapter is the only provider boundary. If its two settings are
 * absent the worker still starts and stays alive, but claims nothing, so a
 * missing credential in an environment never marks queued Runs failed. There is
 * no fallback provider: provider selection is not a runtime decision here.
 */
import { HermesHttpAdapter } from '../adapters/hermes-http-adapter.js';
import { RunEventStore } from '../events/index.js';
import { UsageLimitService } from '../limits/index.js';
import { createPersistencePool } from '../persistence/database.js';
import {
  readDatabaseUrl,
  readHermesConfig,
  readWorkerLoopConfig,
} from './config.js';
import { consoleJsonLogger } from './logger.js';
import { WorkerRunRepository } from './run-claim-repository.js';
import { RunDispatcher } from './run-dispatcher.js';
import { WorkerRunner } from './worker-runner.js';

export interface WorkerRuntimeHandle {
  /** Stops claiming, drains or abandons dispatch, then closes the pool. */
  stop(): Promise<void>;
}

export async function createWorkerRuntime(): Promise<WorkerRuntimeHandle> {
  const config = readWorkerLoopConfig();
  const databaseUrl = readDatabaseUrl();
  const logger = consoleJsonLogger;
  const hermes = readHermesConfig();

  const pool = createPersistencePool({
    connectionString: databaseUrl,
    max: config.concurrency + 2,
  });

  let stopped = false;

  if (hermes === null) {
    logger.log({
      event: 'worker.adapter_unconfigured',
      service: 'worker',
      detail:
        'HABI_HERMES_BASE_URL/HABI_HERMES_GATEWAY_KEY are not set; no Runs will be claimed',
    });

    return {
      stop: async (): Promise<void> => {
        if (stopped) {
          return;
        }

        stopped = true;
        await pool.end();
      },
    };
  }

  const adapter = new HermesHttpAdapter(hermes);
  const events = new RunEventStore(pool);
  const limits = new UsageLimitService(pool);
  const workerRepository = new WorkerRunRepository(pool);
  const dispatcher = new RunDispatcher({
    pool,
    adapter,
    workerRepository,
    events,
    limits,
    logger,
    leaseMs: config.leaseMs,
  });
  const runner = new WorkerRunner({
    pool,
    dispatcher,
    workerRepository,
    logger,
    config,
  });

  try {
    await runner.start();
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }

  logger.log({
    event: 'worker.runtime.started',
    service: 'worker',
    concurrency: config.concurrency,
    leaseMs: config.leaseMs,
    idleBackoffMs: config.idleBackoffMs,
  });

  return {
    stop: async (): Promise<void> => {
      if (stopped) {
        return;
      }

      stopped = true;

      try {
        await runner.stop();
      } finally {
        await adapter.close().catch(() => {});
        await pool.end();
      }
    },
  };
}
