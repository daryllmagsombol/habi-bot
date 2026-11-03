/**
 * Spike-only. Not product code. Enabled only when HABI_SPIKE_MODE=1.
 *
 * In-memory run store for the ownership spike. Runs are keyed only by the
 * Habi-generated run id; the fake harness id is an opaque field that is never
 * used as a lookup key. Everything is lost on process exit.
 */
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

const RUN_ID_PREFIX = 'run_';
const HARNESS_RUN_ID_PREFIX = 'harness_';
const CONVERSATION_ID_PREFIX = 'conv_';

export type SpikeRunStatus = 'created';

export interface SpikeRunEvent {
  type: string;
  at: string;
  tool?: string;
}

export interface SpikeRun {
  runId: string;
  ownerUserId: string;
  conversationId: string;
  harnessRunId: string;
  status: SpikeRunStatus;
  createdAt: string;
  events: SpikeRunEvent[];
}

export interface SpikeRunView {
  runId: string;
  status: SpikeRunStatus;
  conversationId: string;
  createdAt: string;
}

export function toRunView(run: SpikeRun): SpikeRunView {
  return {
    runId: run.runId,
    status: run.status,
    conversationId: run.conversationId,
    createdAt: run.createdAt,
  };
}

@Injectable()
export class SpikeRunsService {
  private readonly runs = new Map<string, SpikeRun>();

  createRun(ownerUserId: string, conversationId: string | undefined): SpikeRun {
    const now = new Date().toISOString();
    const run: SpikeRun = {
      runId: `${RUN_ID_PREFIX}${randomUUID()}`,
      ownerUserId,
      conversationId: conversationId ?? `${CONVERSATION_ID_PREFIX}${randomUUID()}`,
      harnessRunId: `${HARNESS_RUN_ID_PREFIX}${randomUUID()}`,
      status: 'created',
      createdAt: now,
      events: [{ type: 'run.created', at: now }],
    };

    this.runs.set(run.runId, run);
    return run;
  }

  /**
   * Returns the run only for its owner. Unknown ids and other users' runs are
   * indistinguishable so callers can respond with the same non-enumerating 404.
   */
  findOwnedRun(runId: string, ownerUserId: string): SpikeRun | undefined {
    const run = this.runs.get(runId);

    if (run?.ownerUserId !== ownerUserId) {
      return undefined;
    }

    return run;
  }

  listOwnedRuns(ownerUserId: string): SpikeRun[] {
    return [...this.runs.values()].filter((run) => run.ownerUserId === ownerUserId);
  }

  recordPolicyDenial(run: SpikeRun, tool: string): SpikeRunEvent {
    const event: SpikeRunEvent = {
      type: 'policy.denied',
      tool,
      at: new Date().toISOString(),
    };

    run.events.push(event);
    return event;
  }

  listAuditEvents(run: SpikeRun): SpikeRunEvent[] {
    return run.events.filter((event) => event.type.startsWith('policy.'));
  }
}
