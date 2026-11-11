/**
 * In-process request counters for H-013 (#13), plus run/queue counters for
 * H-013 run observability, plus a Prometheus text formatter.
 *
 * Deliberately small: counts by status class, current in-flight requests, a
 * duration sum/count pair, run enqueue/dispatch/terminal totals, provider
 * outcomes by code, and settable queue/worker gauges. There is no HTTP route,
 * no persistence, and no background exporter yet, so nothing here is a metric
 * stack that outgrows a shared VM. Values reset on process restart and are
 * per process; a scrape endpoint, aggregation, and retention remain open work
 * on #13.
 */
import { Inject, Injectable } from '@nestjs/common';
import { OBSERVABILITY_CONFIG } from './observability-config.js';
import type { ObservabilityConfig } from './observability-config.js';

export const METRIC_PREFIX = 'habi';

export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

const STATUS_CLASSES: readonly StatusClass[] = Object.freeze([
  '1xx',
  '2xx',
  '3xx',
  '4xx',
  '5xx',
  'other',
]);

export function statusClassOf(status: number): StatusClass {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return 'other';
  }

  const candidate = `${Math.trunc(status / 100)}xx`;
  return STATUS_CLASSES.find((value) => value === candidate) ?? 'other';
}

export interface MetricsSnapshot {
  readonly service: string;
  readonly inFlight: number;
  readonly total: number;
  readonly byStatusClass: Readonly<Record<StatusClass, number>>;
  readonly durationMsSum: number;
  readonly durationMsCount: number;
}

@Injectable()
export class RequestMetrics {
  private readonly service: string;
  private readonly counters = new Map<StatusClass, number>();
  private inFlight = 0;
  private durationMsSum = 0;
  private durationMsCount = 0;

  constructor(@Inject(OBSERVABILITY_CONFIG) config: ObservabilityConfig) {
    this.service = config.service;
  }

  beginRequest(): void {
    this.inFlight += 1;
  }

  endRequest(status: number, durationMs: number): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }

    const statusClass = statusClassOf(status);
    this.counters.set(statusClass, (this.counters.get(statusClass) ?? 0) + 1);

    if (Number.isFinite(durationMs) && durationMs >= 0) {
      this.durationMsSum += durationMs;
      this.durationMsCount += 1;
    }
  }

  snapshot(): MetricsSnapshot {
    const byStatusClass = Object.fromEntries(
      STATUS_CLASSES.map((statusClass) => [
        statusClass,
        this.counters.get(statusClass) ?? 0,
      ]),
    ) as Record<StatusClass, number>;

    let total = 0;

    for (const statusClass of STATUS_CLASSES) {
      total += byStatusClass[statusClass];
    }

    return {
      service: this.service,
      inFlight: this.inFlight,
      total,
      byStatusClass,
      durationMsSum: this.durationMsSum,
      durationMsCount: this.durationMsCount,
    };
  }

  /** Prometheus text exposition format (version 0.0.4), newline-terminated. */
  toPrometheus(): string {
    const snapshot = this.snapshot();
    const service = escapeLabelValue(snapshot.service);
    const lines: string[] = [
      `# HELP ${METRIC_PREFIX}_http_requests_in_flight HTTP requests currently being handled.`,
      `# TYPE ${METRIC_PREFIX}_http_requests_in_flight gauge`,
      `${METRIC_PREFIX}_http_requests_in_flight{service="${service}"} ${snapshot.inFlight}`,
      `# HELP ${METRIC_PREFIX}_http_requests_total HTTP requests handled, by status class.`,
      `# TYPE ${METRIC_PREFIX}_http_requests_total counter`,
    ];

    for (const statusClass of STATUS_CLASSES) {
      lines.push(
        `${METRIC_PREFIX}_http_requests_total{service="${service}",status_class="${statusClass}"} ${snapshot.byStatusClass[statusClass]}`,
      );
    }

    lines.push(
      `# HELP ${METRIC_PREFIX}_http_request_duration_ms Request handling duration in milliseconds.`,
      `# TYPE ${METRIC_PREFIX}_http_request_duration_ms summary`,
      `${METRIC_PREFIX}_http_request_duration_ms_sum{service="${service}"} ${formatNumber(snapshot.durationMsSum)}`,
      `${METRIC_PREFIX}_http_request_duration_ms_count{service="${service}"} ${snapshot.durationMsCount}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

/**
 * In-process run/queue counters for H-013 run observability.
 *
 * Records run lifecycle transitions (enqueue, dispatch accept/skip, terminal
 * outcome by status), provider call outcomes (success or normalized failure
 * code plus retry decision), and queue/worker health as caller-set gauges
 * (depth, oldest age, failure count, in-flight dispatches). Like the request
 * counters, this is in-process only: no HTTP route, no persistence, and no
 * exporter. Gauges are set by the owning worker loop from database reads; the
 * counter never queries the database itself.
 *
 * Cardinality is bounded by fixed vocabulary: statuses, dispatch states, and
 * failure codes are validated against closed sets. Anything unrecognized
 * collapses to a stable `other` bucket, so a new provider string can never
 * multiply Prometheus series.
 */
export type RunTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'execution_uncertain'
  | 'other_terminal';

export type RunSkipReason =
  | 'deduplicated'
  | 'terminal'
  | 'claimed_elsewhere'
  | 'cancel_requested'
  | 'invalid_context'
  | 'other_skip';

export type ProviderOutcome = 'success' | 'failure';

const RUN_TERMINAL_STATUSES: readonly RunTerminalStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'execution_uncertain',
  'other_terminal',
]);

const RUN_DISPATCH_STATES = ['not_dispatched', 'dispatched', 'unknown'] as const;

const RUN_SKIP_REASONS: readonly RunSkipReason[] = Object.freeze([
  'deduplicated',
  'terminal',
  'claimed_elsewhere',
  'cancel_requested',
  'invalid_context',
  'other_skip',
]);

/** Normalized provider/adapter failure codes shared with the adapter contract. */
const PROVIDER_ERROR_CODES = [
  'auth_rejected',
  'invalid_request',
  'policy_denied',
  'idempotency_conflict',
  'transport_ambiguous',
  'provider_error',
  'provider_rate_limited',
  'provider_exhausted',
  'timeout',
  'harness_unavailable',
  'other_error',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface RunMetricsSnapshot {
  readonly service: string;
  readonly enqueued: number;
  readonly dispatchAccepted: number;
  readonly dispatchSkippedByReason: Readonly<Record<RunSkipReason, number>>;
  readonly terminalByStatus: Readonly<Record<RunTerminalStatus, number>>;
  readonly providerSuccess: number;
  readonly providerFailureByCode: Readonly<Record<ProviderErrorCode, number>>;
  readonly providerRetried: number;
  readonly queueDepth: number | null;
  readonly queueOldestAgeMs: number | null;
  readonly queueFailures: number;
  readonly workerInFlight: number;
}

export function normalizeRunTerminalStatus(status: string): RunTerminalStatus {
  const found = RUN_TERMINAL_STATUSES.find((value) => value === status);
  return found ?? 'other_terminal';
}

export function normalizeRunDispatchState(status: string): string {
  const found = (RUN_DISPATCH_STATES as readonly string[]).find(
    (value) => value === status,
  );
  return found ?? 'other';
}

export function normalizeSkipReason(reason: string): RunSkipReason {
  const found = RUN_SKIP_REASONS.find((value) => value === reason);
  return found ?? 'other_skip';
}

export function normalizeProviderErrorCode(code: string): ProviderErrorCode {
  const found = (
    PROVIDER_ERROR_CODES as readonly string[]
  ).find((value) => value === code);
  return (found ?? 'other_error') as ProviderErrorCode;
}

@Injectable()
export class RunMetrics {
  private readonly service: string;
  private enqueued = 0;
  private dispatchAccepted = 0;
  private readonly dispatchSkipped = new Map<RunSkipReason, number>();
  private readonly terminalByStatus = new Map<RunTerminalStatus, number>();
  private providerSuccess = 0;
  private readonly providerFailure = new Map<ProviderErrorCode, number>();
  private providerRetried = 0;
  private queueDepth: number | null = null;
  private queueOldestAgeMs: number | null = null;
  private queueFailures = 0;
  private workerInFlight = 0;

  constructor(@Inject(OBSERVABILITY_CONFIG) config: ObservabilityConfig) {
    this.service = config.service;
  }

  /** A Run row was reserved (or re-served from an existing idempotency key). */
  recordEnqueue(deduplicated: boolean): void {
    this.enqueued += 1;

    if (deduplicated) {
      this.recordDispatchSkip('deduplicated');
    }
  }

  /** The single atomic claim won and the adapter accepted the dispatch. */
  recordDispatchAccepted(): void {
    this.dispatchAccepted += 1;
  }

  /** The Run never reached the provider; one decision explains why. */
  recordDispatchSkip(reason: string): void {
    const normalized = normalizeSkipReason(reason);
    this.dispatchSkipped.set(
      normalized,
      (this.dispatchSkipped.get(normalized) ?? 0) + 1,
    );
  }

  /** Exactly one terminal row was written (or adopted from another writer). */
  recordTerminal(status: string): void {
    const normalized = normalizeRunTerminalStatus(status);
    this.terminalByStatus.set(
      normalized,
      (this.terminalByStatus.get(normalized) ?? 0) + 1,
    );
  }

  /**
   * One provider call outcome. `errorCode` is the normalized failure code
   * (only read when `outcome` is `failure`); `retried` records whether the
   * caller scheduled another provider attempt. This slice never retries
   * ambiguous work, so `retried` is expected to stay zero except for
   * caller-owned re-dispatch decisions.
   */
  recordProviderCall(
    outcome: ProviderOutcome,
    errorCode?: string,
    retried?: boolean,
  ): void {
    if (outcome === 'success') {
      this.providerSuccess += 1;
    } else {
      const normalized = normalizeProviderErrorCode(errorCode ?? 'other_error');
      this.providerFailure.set(
        normalized,
        (this.providerFailure.get(normalized) ?? 0) + 1,
      );
    }

    if (retried === true) {
      this.providerRetried += 1;
    }
  }

  /**
   * Queue-depth and queue-age gauges. Set by the owning worker loop from a
   * bounded database read; rejects non-finite or negative values so stale or
   * corrupt input can never move Prometheus backwards through nonsense.
   */
  setQueueHealth(input: {
    readonly depth: number;
    readonly oldestAgeMs: number | null;
  }): void {
    if (Number.isSafeInteger(input.depth) && input.depth >= 0) {
      this.queueDepth = input.depth;
    }

    if (input.oldestAgeMs === null) {
      this.queueOldestAgeMs = null;
      return;
    }

    if (
      typeof input.oldestAgeMs === 'number' &&
      Number.isFinite(input.oldestAgeMs) &&
      input.oldestAgeMs >= 0
    ) {
      this.queueOldestAgeMs = input.oldestAgeMs;
    }
  }

  /** A terminal outcome the queue owner attributes to a queue/claim failure. */
  recordQueueFailure(): void {
    this.queueFailures += 1;
  }

  /** Worker-claim saturation: incremented when a dispatch starts, decremented at settle. */
  beginDispatch(): void {
    this.workerInFlight += 1;
  }

  endDispatch(): void {
    if (this.workerInFlight > 0) {
      this.workerInFlight -= 1;
    }
  }

  snapshot(): RunMetricsSnapshot {
    return {
      service: this.service,
      enqueued: this.enqueued,
      dispatchAccepted: this.dispatchAccepted,
      dispatchSkippedByReason: Object.fromEntries(
        RUN_SKIP_REASONS.map((reason) => [
          reason,
          this.dispatchSkipped.get(reason) ?? 0,
        ]),
      ) as Record<RunSkipReason, number>,
      terminalByStatus: Object.fromEntries(
        RUN_TERMINAL_STATUSES.map((status) => [
          status,
          this.terminalByStatus.get(status) ?? 0,
        ]),
      ) as Record<RunTerminalStatus, number>,
      providerSuccess: this.providerSuccess,
      providerFailureByCode: Object.fromEntries(
        PROVIDER_ERROR_CODES.map((code) => [
          code,
          this.providerFailure.get(code) ?? 0,
        ]),
      ) as Record<ProviderErrorCode, number>,
      providerRetried: this.providerRetried,
      queueDepth: this.queueDepth,
      queueFailures: this.queueFailures,
      queueOldestAgeMs: this.queueOldestAgeMs,
      workerInFlight: this.workerInFlight,
    };
  }

  toPrometheus(): string {
    const snapshot = this.snapshot();
    const service = escapeLabelValue(snapshot.service);
    const lines: string[] = [
      `# HELP ${METRIC_PREFIX}_runs_enqueued_total Run reservations created.`,
      `# TYPE ${METRIC_PREFIX}_runs_enqueued_total counter`,
      `${METRIC_PREFIX}_runs_enqueued_total{service="${service}"} ${snapshot.enqueued}`,
      `# HELP ${METRIC_PREFIX}_runs_dispatch_accepted_total Dispatches that reached the provider.`,
      `# TYPE ${METRIC_PREFIX}_runs_dispatch_accepted_total counter`,
      `${METRIC_PREFIX}_runs_dispatch_accepted_total{service="${service}"} ${snapshot.dispatchAccepted}`,
      `# HELP ${METRIC_PREFIX}_runs_dispatch_skipped_total Dispatches skipped, by reason.`,
      `# TYPE ${METRIC_PREFIX}_runs_dispatch_skipped_total counter`,
    ];

    for (const reason of RUN_SKIP_REASONS) {
      lines.push(
        `${METRIC_PREFIX}_runs_dispatch_skipped_total{service="${service}",reason="${reason}"} ${snapshot.dispatchSkippedByReason[reason]}`,
      );
    }

    lines.push(
      `# HELP ${METRIC_PREFIX}_runs_terminal_total Terminal runs, by status.`,
      `# TYPE ${METRIC_PREFIX}_runs_terminal_total counter`,
    );

    for (const status of RUN_TERMINAL_STATUSES) {
      lines.push(
        `${METRIC_PREFIX}_runs_terminal_total{service="${service}",status="${status}"} ${snapshot.terminalByStatus[status]}`,
      );
    }

    lines.push(
      `# HELP ${METRIC_PREFIX}_provider_calls_total Provider calls by outcome and normalized code.`,
      `# TYPE ${METRIC_PREFIX}_provider_calls_total counter`,
      `${METRIC_PREFIX}_provider_calls_total{service="${service}",outcome="success",error_code="none"} ${snapshot.providerSuccess}`,
    );

    for (const code of PROVIDER_ERROR_CODES) {
      lines.push(
        `${METRIC_PREFIX}_provider_calls_total{service="${service}",outcome="failure",error_code="${code}"} ${snapshot.providerFailureByCode[code]}`,
      );
    }

    lines.push(
      `# HELP ${METRIC_PREFIX}_provider_calls_retried_total Provider calls followed by another attempt.`,
      `# TYPE ${METRIC_PREFIX}_provider_calls_retried_total counter`,
      `${METRIC_PREFIX}_provider_calls_retried_total{service="${service}"} ${snapshot.providerRetried}`,
      `# HELP ${METRIC_PREFIX}_queue_depth Current queued, claimable runs as last reported by the worker.`,
      `# TYPE ${METRIC_PREFIX}_queue_depth gauge`,
      `${METRIC_PREFIX}_queue_depth{service="${service}"} ${snapshot.queueDepth ?? 0}`,
      `# HELP ${METRIC_PREFIX}_queue_oldest_age_ms Age of the oldest queued run in milliseconds.`,
      `# TYPE ${METRIC_PREFIX}_queue_oldest_age_ms gauge`,
      `${METRIC_PREFIX}_queue_oldest_age_ms{service="${service}"} ${snapshot.queueOldestAgeMs ?? 0}`,
      `# HELP ${METRIC_PREFIX}_queue_failures_total Queue/claim failures observed.`,
      `# TYPE ${METRIC_PREFIX}_queue_failures_total counter`,
      `${METRIC_PREFIX}_queue_failures_total{service="${service}"} ${snapshot.queueFailures}`,
      `# HELP ${METRIC_PREFIX}_worker_in_flight Dispatches currently owned by the worker.`,
      `# TYPE ${METRIC_PREFIX}_worker_in_flight gauge`,
      `${METRIC_PREFIX}_worker_in_flight{service="${service}"} ${snapshot.workerInFlight}`,
    );

    return lines.join('\n');
  }
}

/** Characters the Prometheus text format requires an escape for. */
const LABEL_SPECIAL_CHARACTERS = /[\n"\\]/g;

/** Escapes one label character: backslash, newline, and double quote. */
function escapeLabelCharacter(character: string): string {
  if (character === '"') {
    return String.raw`\"`;
  }

  if (character === '\n') {
    return String.raw`\n`;
  }

  return String.raw`\\`;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll(LABEL_SPECIAL_CHARACTERS, escapeLabelCharacter);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }

  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}
