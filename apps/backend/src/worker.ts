import 'reflect-metadata';
import { MessageChannel } from 'node:worker_threads';
import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
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

async function bootstrap(): Promise<void> {
  const context = await NestFactory.createApplicationContext(WorkerModule, {
    logger: false,
  });

  context.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], {
    useProcessExit: true,
  });

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
