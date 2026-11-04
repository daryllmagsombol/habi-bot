export type RunState = 'streaming' | 'complete';

export interface RunEvent {
  readonly at: string;
  readonly label: string;
  readonly seq: number;
}

export interface PanelRun {
  readonly id: string;
  readonly state: RunState;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly durationMs?: number;
  readonly tools: number;
  readonly events: readonly RunEvent[];
}

export interface AllowanceView {
  readonly used: number;
  readonly limit: number;
  readonly reset: string;
}

export type MemoryGate = 'bot' | 'thread';

export interface MemoryGateItem {
  readonly id: string;
  readonly text: string;
  readonly botApproved: boolean;
  readonly threadApproved: boolean;
}

export interface MemoryItem {
  readonly id: string;
  readonly text: string;
  readonly recalled: boolean;
}

export type DocumentBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string; readonly cited?: boolean }
  | { readonly kind: 'list'; readonly items: readonly string[] };

export interface DocumentView {
  readonly id: string;
  readonly name: string;
  readonly bytes: string;
  readonly attachedAt: string;
  readonly citedParagraph: number;
  readonly blocks: readonly DocumentBlock[];
}
