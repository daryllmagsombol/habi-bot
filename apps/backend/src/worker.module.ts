/**
 * Headless worker composition root.
 *
 * `HABI_P1_WORKER=1` is the only switch. When it is unset, the runtime factory
 * returns `null` and never imports `./worker/**`, so the process is exactly the
 * inert keep-alive shell it was before: no pool, no adapter, no HTTP listener.
 *
 * When enabled, the factory starts the claim loop and the lifecycle hook drains
 * it before Nest's shutdown hooks exit the process. The dynamic import keeps
 * the flag check and the database code in separate module graphs.
 */
import {
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';

export const WORKER_RUNTIME = Symbol('HABI_WORKER_RUNTIME');

export interface WorkerRuntimeHandle {
  stop(): Promise<void>;
}

const workerRuntimeProvider = {
  provide: WORKER_RUNTIME,
  useFactory: async (): Promise<WorkerRuntimeHandle | null> => {
    if (process.env.HABI_P1_WORKER !== '1') {
      return null;
    }

    const { createWorkerRuntime } = await import('./worker/runtime.js');

    return createWorkerRuntime();
  },
};

@Injectable()
class WorkerLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(WORKER_RUNTIME)
    private readonly runtime: WorkerRuntimeHandle | null,
  ) {}

  /** Stop claiming, drain or abandon in-flight work, then close the pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
  }
}

@Module({
  providers: [workerRuntimeProvider, WorkerLifecycle],
})
export class WorkerModule {}
