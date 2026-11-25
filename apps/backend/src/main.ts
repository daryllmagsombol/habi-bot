import 'reflect-metadata';
import { ShutdownSignal } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { HttpExceptionFilter } from './observability/http-exception.filter.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3001;

function readHost(raw: string | undefined): string {
  const host = raw?.trim();
  return host || DEFAULT_HOST;
}

function readPort(raw: string | undefined): number {
  const value = raw?.trim();

  if (!value) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`PORT must be an integer between 1 and 65535; received "${raw}".`);
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received "${raw}".`);
  }

  return port;
}

async function bootstrap(): Promise<void> {
  const host = readHost(process.env.HOST);
  const port = readPort(process.env.PORT);
  const app = await NestFactory.create(AppModule, { logger: false });

  // Catch-all fallback. Controller-scoped filters (ApiErrorFilter on the P1
  // controllers) still win for the error families they declare; this one owns
  // everything else, so an unexpected throw becomes a coded 5xx with a
  // request id instead of a stack trace.
  app.useGlobalFilters(app.get(HttpExceptionFilter));

  app.enableShutdownHooks([ShutdownSignal.SIGTERM, ShutdownSignal.SIGINT], {
    useProcessExit: true,
  });

  await app.listen(port, host);

  console.log(JSON.stringify({ event: 'api.ready', service: 'api', host, port }));
}

try {
  await bootstrap();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: 'api.error', message }));
  process.exitCode = 1;
}
