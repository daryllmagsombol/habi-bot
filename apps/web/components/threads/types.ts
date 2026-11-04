import type { MetaItem } from '../ui';

export type MessageVariant = 'user' | 'bot';
export type MessageState = 'complete' | 'streaming';
export type RunState = 'streaming' | 'complete';

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
