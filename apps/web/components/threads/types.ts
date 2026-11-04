import type { MetaItem } from '../ui';

export type MessageVariant = 'user' | 'bot';
export type MessageState = 'complete' | 'streaming';
/**
 * Run lifecycle as the UI can observe it. `queued` and `streaming` are live;
 * `complete`, `stopped`, and `failed` are terminal outcomes, each named so a
 * failed or cancelled run never reads as a successful one.
 */
export type RunState = 'queued' | 'streaming' | 'complete' | 'stopped' | 'failed';

export interface RunEventView {
  readonly at: string;
  readonly label: string;
  readonly seq: number;
}

export interface RunView {
  readonly id: string;
  readonly state: RunState;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly durationMs?: number | undefined;
  readonly tools: number;
  /** False when the server reported usage as unknown; never rendered as zero. */
  readonly tokensKnown?: boolean | undefined;
  readonly events: readonly RunEventView[];
}

export interface CitationView {
  readonly label: string;
  readonly href: string;
}

export interface TranscriptMessage {
  readonly id: string;
  readonly variant: MessageVariant;
  readonly at: string;
  readonly paragraphs: readonly string[];
  readonly state?: MessageState | undefined;
  readonly citation?: CitationView | undefined;
  readonly run?: RunView | undefined;
}

export interface ThreadView {
  readonly id: string;
  readonly title: string;
  readonly metaItems: readonly MetaItem[];
  readonly messages: readonly TranscriptMessage[];
}

export interface ThreadListItem {
  readonly id: string;
  readonly title: string;
  readonly time: string;
  readonly href: string;
}
