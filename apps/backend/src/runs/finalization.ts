/**
 * Shared terminal side effects for one Run.
 *
 * A Run row is terminal before its allowance hold and its replay events are
 * written. Both the worker's streaming path and the service's dispatch/recovery
 * paths need the identical order:
 *
 *   1. settle the H-023 reservation from the stored usage, or release it when
 *      the Run provably never reached the provider;
 *   2. append `usage.recorded` for known/partial usage, then exactly one
 *      terminal event whose type matches the stored status.
 *
 * Both writes are idempotent: the reservation state and the deterministic event
 * id make a repeated finalization return the stored outcome instead of charging
 * twice or allocating a second sequence.
 */
import { createHash } from 'node:crypto';
import {
  RunEventStreamClosedError,
  type RunEventStore,
} from '../events/index.js';
import type { SettleUsageInput, UsageLimitService } from '../limits/index.js';
import type { RunRepository, RunRow } from './run-repository.js';
import { isTerminalRunStatus } from './types.js';
import type { PersistedRunStatus } from './types.js';

const UUID_LENGTH = 32;
const TERMINAL_EVENT_DISCRIMINATOR = 'terminal';
const USAGE_EVENT_DISCRIMINATOR = 'usage';

export interface RunSideEffectLogger {
  log(entry: {
    readonly event: string;
    readonly [field: string]: unknown;
  }): void;
}

export interface RunSideEffectDeps {
  readonly repository: RunRepository;
  readonly events?: RunEventStore;
  readonly limits?: UsageLimitService;
  readonly logger?: RunSideEffectLogger;
}

function toNullableNumber(value: string | number | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Stable UUID-shaped idempotency key for an append. A repeated finalization
 * must return the stored event rather than allocating a second sequence.
 */
export function deterministicEventId(
  runId: string,
  discriminator: string,
): string {
  const hex = createHash('sha256')
    .update(`${runId}\u0000${discriminator}`, 'utf8')
    .digest('hex')
    .slice(0, UUID_LENGTH);

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function terminalEventType(status: PersistedRunStatus): string {
  if (status === 'completed') {
    return 'run.completed';
  }

  if (status === 'cancelled') {
    return 'run.cancelled';
  }

  return 'run.failed';
}

/**
 * Applies the allowance and replay side effects for a terminal Run row. Callers
 * must invoke this only after the terminal UPDATE has committed.
 */
export async function applyTerminalSideEffects(
  deps: RunSideEffectDeps,
  row: RunRow,
): Promise<void> {
  if (!isTerminalRunStatus(row.status)) {
    return;
  }

  await settleReservation(deps, row);
  await appendTerminalEvents(deps, row);
}

async function settleReservation(
  deps: RunSideEffectDeps,
  row: RunRow,
): Promise<void> {
  if (deps.limits === undefined) {
    return;
  }

  let reservation;

  try {
    reservation = await deps.repository.findReservation(
      row.id,
      row.owner_user_id,
    );
  } catch (error) {
    deps.logger?.log({
      event: 'run.usage_lookup_failed',
      runId: row.id,
      message: error instanceof Error ? error.name : 'unknown_error',
    });
    return;
  }

  if (reservation?.state !== 'reserved') {
    return;
  }

  try {
    if (row.dispatch_state === 'not_dispatched') {
      await deps.limits.release(reservation.id, {
        ownerUserId: row.owner_user_id,
      });
      return;
    }

    const usage: SettleUsageInput = {
      status: row.usage_status,
      grossPromptTokens: toNullableNumber(row.usage_gross_prompt_tokens),
      grossCompletionTokens: toNullableNumber(row.usage_gross_completion_tokens),
      cachedPromptTokens: toNullableNumber(row.usage_cached_prompt_tokens),
      reasoningTokens: toNullableNumber(row.usage_reasoning_tokens),
      totalTokens: toNullableNumber(row.usage_total_tokens),
    };

    await deps.limits.settle(reservation.id, usage, {
      ownerUserId: row.owner_user_id,
    });
  } catch (error) {
    deps.logger?.log({
      event: 'run.usage_settlement_failed',
      runId: row.id,
      message: error instanceof Error ? error.name : 'unknown_error',
    });
  }
}

async function appendTerminalEvents(
  deps: RunSideEffectDeps,
  row: RunRow,
): Promise<void> {
  if (deps.events === undefined) {
    return;
  }

  if (row.usage_status !== 'unknown') {
    await appendSafely(deps, row, {
      type: 'usage.recorded',
      payload: {
        usageStatus: row.usage_status,
        grossPromptTokens: toNullableNumber(row.usage_gross_prompt_tokens),
        grossCompletionTokens: toNullableNumber(
          row.usage_gross_completion_tokens,
        ),
        cachedPromptTokens: toNullableNumber(row.usage_cached_prompt_tokens),
        reasoningTokens: toNullableNumber(row.usage_reasoning_tokens),
        totalTokens: toNullableNumber(row.usage_total_tokens),
        costStatus: row.usage_cost_status,
      },
      eventId: deterministicEventId(row.id, USAGE_EVENT_DISCRIMINATOR),
    });
  }

  await appendSafely(deps, row, {
    type: terminalEventType(row.status),
    payload: {
      errorCode: row.error_code,
      usageStatus: row.usage_status,
    },
    eventId: deterministicEventId(row.id, TERMINAL_EVENT_DISCRIMINATOR),
  });
}

async function appendSafely(
  deps: RunSideEffectDeps,
  row: RunRow,
  input: {
    type: string;
    payload: Readonly<Record<string, unknown>>;
    eventId: string;
  },
): Promise<void> {
  const events = deps.events;

  if (events === undefined) {
    return;
  }

  try {
    await events.append(row.owner_user_id, {
      runId: row.id,
      type: input.type,
      payload: input.payload,
      eventId: input.eventId,
    });
  } catch (error) {
    if (error instanceof RunEventStreamClosedError) {
      return;
    }

    deps.logger?.log({
      event: 'run.event_append_failed',
      runId: row.id,
      eventType: input.type,
      message: error instanceof Error ? error.name : 'unknown_error',
    });
  }
}
