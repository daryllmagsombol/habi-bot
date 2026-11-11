/**
 * H-020 (#20) event exports.
 *
 * Importing this barrel creates nothing and touches no database or network.
 * `RunEventStore` and `RunEventStream` are constructed explicitly by the
 * composing lane; there is no Nest provider or HTTP/SSE route yet.
 */
export {
  RUN_EVENT_STREAM_CLOSED_CODE,
  RunEventStreamClosedError,
} from './errors.js';
export { RunEventHub } from './run-event-hub.js';
export type { RunEventListener } from './run-event-hub.js';
export { RunEventStore } from './run-event-store.js';
export {
  RunEventStream,
  type RunEventSubscribeOptions,
} from './run-event-stream.js';
export {
  DEFAULT_EVENT_REPLAY_LIMIT,
  DEFAULT_POLL_LIMIT,
  MAX_EVENT_CURSOR_LENGTH,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_REPLAY_LIMIT,
  MAX_EVENT_TYPE_LENGTH,
  MAX_POLL_LIMIT,
  decodeRunEventCursor,
  encodeRunEventCursor,
  normalizeAfterSeq,
  normalizeEventId,
  normalizeEventType,
  normalizePollLimit,
  normalizeReplayLimit,
  serializeEventPayload,
} from './validation.js';
export type { DecodedRunEventCursor } from './validation.js';
export {
  isTerminalRunEventType,
  KNOWN_RUN_EVENT_TYPES,
  RUN_TERMINAL_EVENT_TYPES,
} from './types.js';
export type {
  AppendRunEventInput,
  AppendRunEventResult,
  KnownRunEventPayloads,
  KnownRunEventType,
  MessageCompletedEventPayload,
  MessageDeltaEventPayload,
  PolicyDeniedEventPayload,
  RunCreatedEventPayload,
  RunEventEnvelope,
  RunEventPosition,
  RunEventReplayOptions,
  RunEventReplayPage,
  RunEventStreamItem,
  RunEventType,
  RunTerminalEventPayload,
  TerminalRunEventType,
  UsageRecordedEventPayload,
} from './types.js';
