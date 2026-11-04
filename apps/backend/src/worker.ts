import 'reflect-metadata';
import { MessageChannel } from 'node:worker_threads';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { WorkerModule } from './worker.module.js';

// A ref'd message port keeps the headless worker alive without timers or I/O.
// The keep-alive is also what makes the flag-off path inert: `WorkerModule`
// returns a null runtime unless HABI_P1_WORKER=1, so nothing from `worker/**`
// is even imported.
const keepAlive = new MessageChannel();
keepAlive.port1.start();
keepAlive.port1.ref();
keepAlive.port2.start();
keepAlive.port2.ref();

/**
 * Shutdown is owned here rather than by `enableShutdownHooks`, because Nest's
 * hook path exits the process from its own signal handler: a second SIGTERM
 * arriving while the drain is still running then terminates the process by
 * signal, which is neither a clean exit nor a drain. This guard makes the
 * first signal start the drain and every later signal a no-op, so a supervisor
 * that repeats or escalates signals still gets exit 0 after the work stops.
 */
function installShutdownGuard(context: INestApplicationContext): void {
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) {
      return;
    }

    stopping = true;

    void context
      .close()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ event: 'worker.shutdown_error', message }));
      })
      .finally(() => {
        keepAlive.port1.close();
        keepAlive.port2.close();
        process.exit(0);
      });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function bootstrap(): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });

  installShutdownGuard(context);

  console.log(JSON.stringify({ event: 'worker.ready', service: 'worker' }));
}

try {
  await bootstrap();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: 'worker.error', message }));
  keepAlive.port1.close();
  keepAlive.port2.close();
  process.exitCode = 1;
}
