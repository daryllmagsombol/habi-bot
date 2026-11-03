/**
 * H-020 (#20) Run event contract: ordered, replayable events for one Run.
 *
 * The envelope is the one fixed by H-002 / H-021:
 *
 *   { id, runId, ownerUserId, conversationId, seq, type, payload, createdAt }
 *
 * Rules:
 *   - `seq` is allocated by Habi per Run from 1 and is the only ordering key.
 *     `createdAt` is display metadata and may be equal across rows.
 *   - Delivery is at-least-once. Consumers dedupe by `(runId, seq)`; replay
 *     starts after the last applied `seq` (`afterSeq`).
 *   - Exactly one terminal type may be appended per Run, and no event may
 *     follow it. The terminal event is immutable and replayable.
 *   - A payload is a JSON object. It carries normalized, bounded event data
 *     and never a secret, credential, or full prompt body.
 *
 * `timed_out` and `execution_uncertain` are Habi run outcomes, not extra
 * terminal event types in this slice: they are emitted as `run.failed` with a
 * normalized `errorCode` payload (`timeout`, `execution_uncertain`).
 */
import type { DispatchState, UsageStatus } from '../adapters/harness-adapter.js';

/** Event names Habi itself emits. Unknown harness names pass through unchanged. */
export type KnownRunEventType =
  | 'run.created'
  | 'message.delta'
  | 'message.completed'
  | 'usage.recorded'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'policy.denied';

export type RunEventType = KnownRunEventType | (string & Record<never, never>);

export const KNOWN_RUN_EVENT_TYPES: readonly KnownRunEventType[] = [
  'run.created',
  'message.delta',
  'message.completed',
  'usage.recorded',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'policy.denied',
];

/**
 * The only event types that close a Run stream. A `policy.denied` event is a
 * visible policy outcome, not a run terminal state.
 */
export const RUN_TERMINAL_EVENT_TYPES = [
  'run.completed',
  'run.failed',
  'run.cancelled',
] as const;

export type TerminalRunEventType = (typeof RUN_TERMINAL_EVENT_TYPES)[number];

export function isTerminalRunEventType(
  type: string,
): type is TerminalRunEventType {
  return (RUN_TERMINAL_EVENT_TYPES as readonly string[]).includes(type);
}

export interface RunCreatedEventPayload {
  readonly dispatchState: DispatchState;
}

export interface MessageDeltaEventPayload {
  readonly messageId?: string;
  readonly text: string;
}

export interface MessageCompletedEventPayload {
  readonly messageId?: string;
  readonly text?: string;
}

export interface UsageRecordedEventPayload {
  readonly usageStatus: UsageStatus;
  readonly grossPromptTokens?: number | null;
  readonly grossCompletionTokens?: number | null;
  readonly cachedPromptTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly costStatus?: 'known' | 'unknown';
}

export interface RunTerminalEventPayload {
  readonly errorCode?: string | null;
  readonly usageStatus?: UsageStatus;
}

export interface PolicyDeniedEventPayload {
  readonly code?: string;
}

/**
 * Payload schema by known type. Runtime storage treats a payload as an opaque
 * JSON object; this map documents what each known event may contain so a later
 * transport can render it without parsing vendor text.
 */
export interface KnownRunEventPayloads {
  'run.created': RunCreatedEventPayload;
  'message.delta': MessageDeltaEventPayload;
  'message.completed': MessageCompletedEventPayload;
  'usage.recorded': UsageRecordedEventPayload;
  'run.completed': RunTerminalEventPayload;
  'run.failed': RunTerminalEventPayload;
  'run.cancelled': RunTerminalEventPayload;
  'policy.denied': PolicyDeniedEventPayload;
}

/** One stored Run event. This shape crosses no HTTP boundary in this slice. */
export interface RunEventEnvelope {
  id: string;
  runId: string;
  ownerUserId: string;
  conversationId: string;
  seq: number;
  type: RunEventType;
  payload: Readonly<Record<string, unknown>>;
  /** ISO-8601 UTC; ordering uses `seq`, never this value. */
  createdAt: string;
}

export interface AppendRunEventInput {
  runId: string;
  type: RunEventType;
  payload?: Readonly<Record<string, unknown>>;
  /**
   * Caller-generated idempotency key. Reusing it for the same Run returns the
   * already stored event and allocates no new `seq`.
   */
  eventId?: string;
}

export interface AppendRunEventResult {
  event: RunEventEnvelope;
  /** True when `eventId` matched an existing event; nothing was written. */
  deduplicated: boolean;
}

export interface RunEventReplayOptions {
  /** Exclusive cursor: the first returned event has `seq > afterSeq`. */
  afterSeq?: number;
  /** Page bound; the store clamps to its configured maximum. */
  limit?: number;
}

export interface RunEventReplayPage {
  runId: string;
  /** Echoes the effective exclusive cursor for this page. */
  afterSeq: number;
  events: RunEventEnvelope[];
  /** More persisted events exist after this page. */
  hasMore: boolean;
  /**
   * Highest replayable sequence: the terminal sequence when one exists, else
   * `runs.last_event_seq`. Rows written after the terminal event are hidden.
   */
  lastEventSeq: number;
  /**
   * Sequence of the terminal event when one is stored, or null. A stream that
   * has applied at least this sequence stops.
   */
  terminalEventSeq: number | null;
}

export interface RunEventPosition {
  runId: string;
  conversationId: string;
  /** `runs.last_event_seq`, authoritative for append cursor allocation. */
  lastEventSeq: number;
  terminalEventSeq: number | null;
}

/** One item yielded by a live/replay subscription. */
export type RunEventStreamItem =
  | { kind: 'event'; event: RunEventEnvelope }
  /**
   * Missing sequence range. Emitted instead of silently continuing across a
   * hole, so a client can mark the transcript incomplete.
   */
  | { kind: 'gap'; runId: string; fromSeq: number; toSeq: number };
