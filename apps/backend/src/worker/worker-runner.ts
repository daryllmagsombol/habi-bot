/**
 * Bounded claim loop.
 *
 * One worker process claims at most `batchSize` Runs per statement and keeps at
 * most `concurrency` dispatches in flight. When the queue is empty it backs off
 * (capped exponential) instead of polling in a tight loop, and periodically
 * asks the dispatcher to reconcile claims whose lease expired.
 *
 * Cancellation intents are observed in two places: a live dispatch sees its
 * intent on the next heartbeat (`leaseMs/3`, floored at 250 ms), and every idle
 * iteration sweeps intents for Runs no local task owns (bounded by the idle
 * backoff, whose default ceiling is 5 s).
 *
 * Shutdown is deliberate: stop claiming, give in-flight work `drainMs` to
 * finish, then abort the subscriptions. A Run that was accepted is left
 * non-terminal for restart reconciliation; a Run that was only claimed is
 * returned to `not_dispatched` by the dispatcher. Neither path re-dispatches a
 * possibly-paid call.
 */
import type { Pool } from 'pg';
import { RunRepository } from '../runs/run-repository.js';
import type { RunRow } from '../runs/run-repository.js';
import type { RunRecoverySummary } from '../runs/types.js';
import type { WorkerLoopConfig } from './config.js';
import type { WorkerLogger } from './logger.js';
import type { WorkerRunRepository } from './run-claim-repository.js';
import type { RunDispatcher } from './run-dispatcher.js';

const FORCED_STOP_GRACE_MS = 2_000;

export interface WorkerRunnerOptions {
  readonly pool: Pool;
  readonly dispatcher: RunDispatcher;
  readonly workerRepository: WorkerRunRepository;
  readonly logger: WorkerLogger;
  readonly config: WorkerLoopConfig;
}

export class WorkerRunner {
  private readonly runs: RunRepository;
  private readonly tasks = new Map<string, Promise<void>>();
  private readonly shutdownController = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  private started = false;
  private stopping = false;
  private sweeping = false;
  private lastSweepAt = 0;

  constructor(private readonly options: WorkerRunnerOptions) {
    this.runs = new RunRepository(options.pool);
  }

  /**
   * Reconciles abandoned claims once, then starts the loop. Recovery failures
   * are logged and do not prevent new work from being claimed.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;

    const recovery = await this.recoverAfterRestart();

    this.options.logger.log({
      event: 'worker.recovery',
      outcomes: recovery.outcomes.length,
    });

    this.loopPromise = this.loop();
  }

  /** Stops claiming, drains, then aborts any remaining dispatch. */
  async stop(): Promise<void> {
    if (this.stopping) {
      await this.loopPromise;
      return;
    }

    this.stopping = true;
    this.options.logger.log({ event: 'worker.stopping' });
    this.wakeLoop();

    await this.waitForTasks(this.options.config.drainMs);

    if (this.tasks.size > 0) {
      this.options.logger.log({
        event: 'worker.abandoning_inflight',
        count: this.tasks.size,
      });
      this.shutdownController.abort();
      await this.waitForTasks(FORCED_STOP_GRACE_MS);
    }

    await this.loopPromise;

    this.options.logger.log({ event: 'worker.stopped' });
  }

  /** Runs the same bounded reconciliation the loop performs when idle. */
  recoverAfterRestart(): Promise<RunRecoverySummary> {
    return this.options.dispatcher.recoverAfterRestart(
      this.options.config.recoveryLimit,
    );
  }

  private async loop(): Promise<void> {
    let backoff = this.options.config.idleBackoffMs;

    while (!this.stopping) {
      try {
        const free = this.options.config.concurrency - this.tasks.size;
        const claimed =
          free > 0 ? await this.claim(free) : 0;

        if (this.stopping) {
          break;
        }

        if (claimed === 0) {
          await this.processCancels();
          await this.sweepIfDue();

          if (this.stopping) {
            break;
          }

          await this.wait(backoff);
          backoff = Math.min(
            backoff * 2,
            this.options.config.maxIdleBackoffMs,
          );
          continue;
        }

        backoff = this.options.config.idleBackoffMs;
        // Yield so completed tasks are removed and the next claim observes the
        // real in-flight count before the loop runs again.
        await this.wait(0);
      } catch (error) {
        this.options.logger.log({
          event: 'worker.loop_failed',
          message: error instanceof Error ? error.name : 'unknown_error',
        });
        await this.wait(backoff);
        backoff = Math.min(backoff * 2, this.options.config.maxIdleBackoffMs);
      }
    }
  }

  private async claim(limit: number): Promise<number> {
    const claimed = await this.options.workerRepository.claimBatch(limit);
    let started = 0;

    for (const ref of claimed) {
      let run: RunRow;

      try {
        run = await this.runs.loadOwnedRun(ref.ownerUserId, ref.id);
      } catch {
        // The claim was never dispatched; give it back instead of leaving it
        // leased until recovery.
        await this.options.dispatcher.abandonClaim(ref.id, ref.ownerUserId);
        continue;
      }

      this.options.logger.log({ event: 'run.claimed', runId: run.id });

      const task = this.options.dispatcher
        .dispatch(run, this.shutdownController.signal)
        .catch((error: unknown) => {
          this.options.logger.log({
            event: 'run.dispatch_crashed',
            runId: run.id,
            message: error instanceof Error ? error.name : 'unknown_error',
          });
        })
        .finally(() => {
          this.tasks.delete(run.id);
          this.wakeLoop();
        });

      this.tasks.set(run.id, task);
      started += 1;
    }

    return started;
  }

  /**
   * Handles cancellation intents for Runs no local task is streaming. Runs with
   * a live local stream observe their own intent on the heartbeat; this sweep
   * covers a Run cancelled while queued and one orphaned by a restart. It runs
   * on every idle iteration, so a surviving worker picks the intent up within
   * one idle backoff (default ceiling 5 s, 100 ms in the smoke suites).
   */
  private async processCancels(): Promise<void> {
    if (this.stopping) {
      return;
    }

    try {
      const processed = await this.options.dispatcher.processCancelIntents(
        this.options.config.recoveryLimit,
        [...this.tasks.keys()],
      );

      if (processed > 0) {
        this.options.logger.log({
          event: 'worker.cancel_sweep',
          processed,
        });
      }
    } catch (error) {
      this.options.logger.log({
        event: 'worker.cancel_sweep_failed',
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    }
  }

  /** Reconciliation runs only with no local dispatch in flight. */
  private async sweepIfDue(): Promise<void> {
    if (this.sweeping || this.tasks.size > 0) {
      return;
    }

    const now = Date.now();

    if (
      this.lastSweepAt !== 0 &&
      now - this.lastSweepAt < this.options.config.sweepIntervalMs
    ) {
      return;
    }

    this.sweeping = true;
    this.lastSweepAt = now;

    try {
      const recovery = await this.recoverAfterRestart();

      if (recovery.outcomes.length > 0) {
        this.options.logger.log({
          event: 'worker.recovery',
          outcomes: recovery.outcomes.length,
          trigger: 'lease_sweep',
        });
      }
    } catch (error) {
      this.options.logger.log({
        event: 'worker.recovery_failed',
        message: error instanceof Error ? error.name : 'unknown_error',
      });
    } finally {
      this.sweeping = false;
    }
  }

  private wait(ms: number): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const finish = (): void => {
        if (this.wakeTimer !== null) {
          clearTimeout(this.wakeTimer);
          this.wakeTimer = null;
        }

        this.wake = null;
        resolve();
      };

      this.wake = finish;
      this.wakeTimer = setTimeout(finish, ms);
    });
  }

  /** Ends the current backoff immediately (claim completed or stop). */
  private wakeLoop(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async waitForTasks(timeoutMs: number): Promise<void> {
    if (this.tasks.size === 0) {
      return;
    }

    const all = Promise.allSettled(this.tasks.values());

    await Promise.race([
      all,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  }
}
