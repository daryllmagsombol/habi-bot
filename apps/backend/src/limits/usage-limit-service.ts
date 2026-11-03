/**
 * H-023 (#23) UsageLimitService: the shared-key daily allowance.
 *
 * Invariants:
 *   - Admission is reserve-then-dispatch. `reserve` is one transaction that
 *     locks the owner's bucket, checks committed usage plus outstanding
 *     reservations, and inserts the reservation. A failed reservation means no
 *     dispatch; a check-then-dispatch without a hold is not allowed.
 *   - The bucket is keyed by Habi user and the Asia/Manila calendar day, so
 *     concurrent runs for one user share one bucket and the reset at 00:00
 *     local time is a boundary change, not a credit event.
 *   - A bucket with unreconciled `unknown` usage refuses reservations (fail
 *     closed). Unknown is never converted to zero: its estimate stays held.
 *   - `settle` maps known/partial/unknown usage without inventing a favourable
 *     number, and `release` exists only for pre-dispatch failures.
 *   - `reconcile` is the owner-triggered way out of the unknown block. It
 *     writes an append-only audit row; nothing here deletes history.
 *
 * No HTTP route, Nest provider, queue, provider call, global budget, admin stop
 * switch, or distributed limiter is wired here. Those are later layers.
 */
import type { Pool } from 'pg';
import { withTransaction } from '../persistence/database.js';
import type { Queryable } from '../persistence/database.js';
import { requireActorUserId, requireResourceId } from '../persistence/rows.js';
import { resolveUsageCharge } from './accounting.js';
import type { ResolvedCharge } from './accounting.js';
import { UsageLimitError } from './errors.js';
import { isDayBucket, manilaDayBucket, nextManilaDayStart } from './time.js';
import {
  UsageLimitRepository,
  toUsageBucket,
  toUsageReservation,
} from './usage-limit-repository.js';
import type { UsageReservationRow } from './usage-limit-repository.js';
import { DAILY_ALLOWANCE_TOKENS } from './types.js';
import type {
  ReconcileUsageOptions,
  ReconcileUsageResult,
  ReserveUsageInput,
  ReservationSettlement,
  SettleUsageInput,
  SettleUsageOptions,
  UsageReservation,
  UsageSnapshot,
} from './types.js';

export interface UsageLimitServiceOptions {
  /**
   * Injected clock. Production passes `() => new Date()`; tests advance it to
   * prove the Asia/Manila boundary. Every stored timestamp and every day bucket
   * comes from this clock, never from the database's `now()`.
   */
  readonly now?: () => Date;
}

const MAX_NOTE_LENGTH = 500;

function toTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeInstant(at: Date): Date {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new UsageLimitError('invalid_input');
  }

  return at;
}

function normalizeEstimate(estimateTokens: number): number {
  if (!Number.isSafeInteger(estimateTokens) || estimateTokens <= 0) {
    throw new UsageLimitError('invalid_input');
  }

  return estimateTokens;
}

function normalizeResolvedTokens(resolvedTokens: number): number {
  if (!Number.isSafeInteger(resolvedTokens) || resolvedTokens < 0) {
    throw new UsageLimitError('invalid_input');
  }

  return resolvedTokens;
}

function normalizeNote(note: string): string {
  const trimmed = typeof note === 'string' ? note.trim() : '';

  if (trimmed.length === 0 || trimmed.length > MAX_NOTE_LENGTH) {
    throw new UsageLimitError('invalid_input');
  }

  return trimmed;
}

function normalizeAttribution(
  options: ReconcileUsageOptions,
): { inputTokens: number; outputTokens: number } {
  const resolved = normalizeResolvedTokens(options.resolvedTokens);
  const input = options.inputTokens;
  const output = options.outputTokens;

  if (input === undefined && output === undefined) {
    // Aggregate-only resolution: the total is enforced either way; it is
    // recorded against input because the split is not known.
    return { inputTokens: resolved, outputTokens: 0 };
  }

  if (input === undefined || output === undefined) {
    throw new UsageLimitError('invalid_input');
  }

  if (
    !Number.isSafeInteger(input) ||
    !Number.isSafeInteger(output) ||
    input < 0 ||
    output < 0 ||
    input + output !== resolved
  ) {
    throw new UsageLimitError('invalid_input');
  }

  return { inputTokens: input, outputTokens: output };
}

function settlementFromRow(row: UsageReservationRow): ReservationSettlement {
  const usageStatus = row.usage_status;

  if (row.state !== 'settled' && row.state !== 'unknown') {
    throw new UsageLimitError('reservation_not_reserved');
  }

  if (usageStatus === null) {
    throw new Error('Terminal reservation has no usage status.');
  }

  return {
    reservationId: row.id,
    runId: row.run_id,
    dayBucket: row.day_bucket,
    state: row.state,
    usageStatus,
    chargedTokens: toUsageReservation(row).chargedTokens,
  };
}

export class UsageLimitService {
  private readonly repository: UsageLimitRepository;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    options: UsageLimitServiceOptions = {},
  ) {
    this.repository = new UsageLimitRepository(pool);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Atomically reserves an upper bound for one Run. Returns the existing
   * reservation when the same owner reuses a run id, so a duplicate submit
   * cannot consume the allowance twice.
   *
   * Refusals: `usage_unknown` (unreconciled bucket, fail closed),
   * `allowance_exhausted` (bucket plus hold would exceed the daily allowance).
   */
  async reserve(input: ReserveUsageInput): Promise<UsageReservation> {
    const ownerUserId = requireActorUserId(input.ownerUserId);
    const runId = requireResourceId(input.runId);
    const estimateTokens = normalizeEstimate(input.estimateTokens);
    const at = normalizeInstant(this.now());
    const dayBucket = manilaDayBucket(at);

    return withTransaction(this.pool, async (client) => {
      const bucket = await this.repository.lockOrCreateBucket(
        client,
        ownerUserId,
        dayBucket,
        at,
      );

      const committed =
        Number(bucket.input_tokens) + Number(bucket.output_tokens);
      const reserved = Number(bucket.reserved_tokens);
      const used = committed + reserved;

      if (bucket.state === 'unknown') {
        throw new UsageLimitError('usage_unknown', {
          limit: DAILY_ALLOWANCE_TOKENS,
          remaining: remainingFrom(used),
        });
      }

      const existing = await this.repository.findReservationByRun(
        client,
        ownerUserId,
        runId,
        true,
      );

      if (existing !== null) {
        if (existing.state === 'reserved') {
          return toUsageReservation(existing);
        }

        throw new UsageLimitError('run_already_accounted');
      }

      if (used + estimateTokens > DAILY_ALLOWANCE_TOKENS) {
        throw new UsageLimitError('allowance_exhausted', {
          limit: DAILY_ALLOWANCE_TOKENS,
          remaining: remainingFrom(used),
          retryAfterSeconds: secondsUntilReset(at),
        });
      }

      const inserted = await this.repository.insertReservation(client, {
        ownerUserId,
        runId,
        dayBucket,
        estimatedTokens: estimateTokens,
        at,
      });

      await this.repository.addReservedTokens(
        client,
        ownerUserId,
        dayBucket,
        estimateTokens,
        at,
      );

      return toUsageReservation(inserted);
    });
  }

  /**
   * Finalizes a reservation from reported usage.
   *
   * `known` and `partial` commit the resolved units and release the hold.
   * `unknown` keeps the full estimate held, marks the bucket unknown, and
   * refuses all further reservations until `reconcile` is called. Repeating a
   * settlement of an already terminal reservation returns its stored outcome;
   * a released reservation can never be settled.
   */
  async settle(
    reservationId: string,
    usage: SettleUsageInput,
    options: SettleUsageOptions = {},
  ): Promise<ReservationSettlement> {
    const id = requireResourceId(reservationId);
    const ownerUserId =
      options.ownerUserId === undefined
        ? null
        : requireActorUserId(options.ownerUserId);
    // Resolve the charge before opening a transaction so invalid provider data
    // fails without touching the bucket.
    const charge = resolveUsageCharge(usage);
    const at = normalizeInstant(this.now());

    return withTransaction(this.pool, async (client) => {
      const reservation = await this.lockReservation(
        client,
        id,
        ownerUserId,
        at,
      );

      if (reservation.state !== 'reserved') {
        if (reservation.state === 'released') {
          throw new UsageLimitError('reservation_not_reserved');
        }

        return settlementFromRow(reservation);
      }

      if (charge.status === 'unknown') {
        await this.repository.settleReservation(client, {
          ownerUserId: reservation.owner_user_id,
          dayBucket: reservation.day_bucket,
          reservationId: reservation.id,
          estimatedTokens: Number(reservation.estimated_tokens),
          inputTokens: 0,
          outputTokens: 0,
          state: 'unknown',
          usageStatus: 'unknown',
          at,
        });

        return {
          reservationId: reservation.id,
          runId: reservation.run_id,
          dayBucket: reservation.day_bucket,
          state: 'unknown',
          usageStatus: 'unknown',
          chargedTokens: Number(reservation.estimated_tokens),
        };
      }

      await this.repository.settleReservation(client, {
        ownerUserId: reservation.owner_user_id,
        dayBucket: reservation.day_bucket,
        reservationId: reservation.id,
        estimatedTokens: Number(reservation.estimated_tokens),
        inputTokens: charge.inputTokens,
        outputTokens: charge.outputTokens,
        state: 'settled',
        usageStatus: charge.status,
        at,
      });

      return settlementFromCharge(reservation, charge);
    });
  }

  /**
   * Releases a reservation for a pre-dispatch failure. Only a `reserved` row can
   * be released; repeating a release returns the stored released reservation.
   */
  async release(
    reservationId: string,
    options: SettleUsageOptions = {},
  ): Promise<UsageReservation> {
    const id = requireResourceId(reservationId);
    const ownerUserId =
      options.ownerUserId === undefined
        ? null
        : requireActorUserId(options.ownerUserId);
    const at = normalizeInstant(this.now());

    return withTransaction(this.pool, async (client) => {
      const reservation = await this.lockReservation(client, id, ownerUserId, at);

      if (reservation.state === 'released') {
        return toUsageReservation(reservation);
      }

      if (reservation.state !== 'reserved') {
        throw new UsageLimitError('reservation_not_reserved');
      }

      const released = await this.repository.releaseReservation(
        client,
        reservation.owner_user_id,
        reservation.day_bucket,
        reservation.id,
        Number(reservation.estimated_tokens),
        at,
      );

      return toUsageReservation(released);
    });
  }

  /**
   * Owner-visible snapshot for the Asia/Manila day containing `at`. A missing
   * bucket reads as a full, unblocked allowance rather than an error.
   */
  async getUsage(ownerUserId: string, at?: Date): Promise<UsageSnapshot> {
    const owner = requireActorUserId(ownerUserId);
    const instant = normalizeInstant(at ?? this.now());
    const dayBucket = manilaDayBucket(instant);
    const row = await this.repository.findBucket(owner, dayBucket);

    if (row === null) {
      return {
        ownerUserId: owner,
        dayBucket,
        limitTokens: DAILY_ALLOWANCE_TOKENS,
        inputTokens: 0,
        outputTokens: 0,
        reservedTokens: 0,
        usedTokens: 0,
        remainingTokens: DAILY_ALLOWANCE_TOKENS,
        state: 'known',
        blocked: false,
        resetsAt: nextManilaDayStart(instant).toISOString(),
      };
    }

    const bucket = toUsageBucket(row);
    const used = bucket.inputTokens + bucket.outputTokens + bucket.reservedTokens;

    return {
      ownerUserId: bucket.ownerUserId,
      dayBucket: bucket.dayBucket,
      limitTokens: DAILY_ALLOWANCE_TOKENS,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      reservedTokens: bucket.reservedTokens,
      usedTokens: used,
      remainingTokens: remainingFrom(used),
      state: bucket.state,
      blocked: bucket.state === 'unknown',
      resetsAt: nextManilaDayStart(instant).toISOString(),
    };
  }

  /**
   * Owner-triggered resolution of an `unknown` bucket. The owner states the
   * actual units for the unknown holds; the difference from the held estimates
   * is applied to committed usage and written to the append-only audit table.
   * The bucket becomes `partial` again if any earlier partial usage remains.
   */
  async reconcile(
    ownerUserId: string,
    dayBucket: string,
    options: ReconcileUsageOptions,
  ): Promise<ReconcileUsageResult> {
    const owner = requireActorUserId(ownerUserId);

    if (!isDayBucket(dayBucket)) {
      throw new UsageLimitError('invalid_input');
    }

    const actorUserId = requireActorUserId(options.actorUserId);

    if (actorUserId !== owner) {
      throw new UsageLimitError('reconcile_not_authorized');
    }

    const resolvedTokens = normalizeResolvedTokens(options.resolvedTokens);
    const attribution = normalizeAttribution(options);
    const note = normalizeNote(options.note);
    const at = normalizeInstant(this.now());

    return withTransaction(this.pool, async (client) => {
      const bucket = await this.repository.lockBucket(client, owner, dayBucket);

      if (bucket === null || bucket.state !== 'unknown') {
        throw new UsageLimitError('reconcile_not_required');
      }

      const holds = await this.repository.listUnknownReservationsForUpdate(
        client,
        owner,
        dayBucket,
      );
      const provisionalTokens = holds.reduce(
        (total, hold) => total + Number(hold.charged_tokens),
        0,
      );

      const markPartial = await this.repository.hasSettledPartial(
        client,
        owner,
        dayBucket,
      );
      const updated = await this.repository.applyReconciliation(client, {
        ownerUserId: owner,
        dayBucket,
        provisionalTokens,
        resolvedInputTokens: attribution.inputTokens,
        resolvedOutputTokens: attribution.outputTokens,
        markPartial,
        at,
      });

      if (updated === null) {
        // A concurrent reconciliation won the state predicate.
        throw new UsageLimitError('reconcile_not_required');
      }

      const reconciledReservations =
        await this.repository.markReservationsReconciled(
          client,
          owner,
          dayBucket,
          actorUserId,
          note,
          at,
        );

      const audit = await this.repository.insertAudit(client, {
        ownerUserId: owner,
        dayBucket,
        actorUserId,
        tokensDelta: resolvedTokens - provisionalTokens,
        note,
        at,
      });

      return {
        ownerUserId: owner,
        dayBucket,
        state: updated.state === 'partial' ? 'partial' : 'known',
        resolvedTokens,
        provisionalTokens,
        deltaTokens: resolvedTokens - provisionalTokens,
        reconciledReservations,
        auditedAt: toTimestamp(audit.created_at),
      };
    });
  }

  /**
   * Append-only audit rows for one owner/day. Reads are owner-scoped so a
   * reconciliation history cannot be enumerated across users.
   */
  async listAudit(
    ownerUserId: string,
    dayBucket: string,
  ): Promise<readonly { tokensDelta: number; note: string; actorUserId: string; at: string }[]> {
    const owner = requireActorUserId(ownerUserId);

    if (!isDayBucket(dayBucket)) {
      throw new UsageLimitError('invalid_input');
    }

    const rows = await this.repository.listAudit(owner, dayBucket);

    return rows.map((row) => ({
      tokensDelta: Number(row.tokens_delta),
      note: row.note,
      actorUserId: row.actor_user_id,
      at: toTimestamp(row.created_at),
    }));
  }

  /**
   * Locks the bucket before the reservation so every path acquires row locks in
   * the same order. The unlocked pre-read exists only to learn the day bucket;
   * the reservation is re-read under lock before any state decision.
   */
  private async lockReservation(
    client: Queryable,
    reservationId: string,
    ownerUserId: string | null,
    at: Date,
  ): Promise<UsageReservationRow> {
    const preview = await this.repository.findReservationById(
      client,
      reservationId,
      ownerUserId,
      false,
    );

    if (preview === null) {
      throw new UsageLimitError('reservation_not_found');
    }

    await this.repository.lockOrCreateBucket(
      client,
      preview.owner_user_id,
      preview.day_bucket,
      at,
    );

    const reservation = await this.repository.findReservationById(
      client,
      reservationId,
      ownerUserId,
      true,
    );

    if (reservation === null) {
      throw new UsageLimitError('reservation_not_found');
    }

    return reservation;
  }
}

function remainingFrom(used: number): number {
  return Math.max(0, DAILY_ALLOWANCE_TOKENS - used);
}

function secondsUntilReset(at: Date): number {
  const resetAt = nextManilaDayStart(at);

  return Math.max(1, Math.ceil((resetAt.getTime() - at.getTime()) / 1000));
}

function settlementFromCharge(
  reservation: UsageReservationRow,
  charge: ResolvedCharge,
): ReservationSettlement {
  if (charge.status === 'unknown') {
    throw new Error('Unknown charge cannot be settled as committed usage.');
  }

  return {
    reservationId: reservation.id,
    runId: reservation.run_id,
    dayBucket: reservation.day_bucket,
    state: 'settled',
    usageStatus: charge.status,
    chargedTokens: charge.totalTokens,
  };
}
