export type RunState = 'queued' | 'streaming' | 'complete' | 'stopped' | 'failed';

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
  /** False when the server reported usage as unknown; never rendered as zero. */
  readonly tokensKnown?: boolean;
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

export type DocumentContentState = 'ready' | 'unavailable' | 'unsupported' | 'error';

export interface DocumentView {
  readonly id: string;
  readonly name: string;
  readonly bytes: string;
  readonly attachedAt: string;
  /** Content type reported by the metadata record. */
  readonly contentType?: string;
  /** `ready` renders blocks; every other state explains why the body is absent. */
  readonly contentState?: DocumentContentState;
  readonly contentMessage?: string;
  readonly citedParagraph: number;
  readonly blocks: readonly DocumentBlock[];
}

/** API bounds for `POST /api/skills`; the form enforces them before sending. */
export const SKILL_NAME_MAX_LENGTH = 80;
export const SKILL_DESCRIPTION_MAX_LENGTH = 500;
export const SKILL_BODY_MAX_BYTES = 64 * 1024;

export interface SkillView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Untrusted Markdown guidance. Rendered as text, never as HTML. */
  readonly bodyMarkdown: string;
  readonly status: 'draft' | 'active' | 'archived' | 'deleted';
  readonly version: number;
  /** Null means owner-level; otherwise the Bot this skill is attached to. */
  readonly botId: string | null;
}

export type ArtifactKind = 'markdown' | 'text' | 'json';
export type ArtifactStatus = 'draft' | 'final' | 'deleted';

export interface ArtifactSummaryView {
  readonly id: string;
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly status: ArtifactStatus;
  readonly currentVersion: number;
  readonly updatedAt: string;
}

export interface ArtifactVersionView {
  readonly version: number;
  readonly byteSize: number;
  readonly createdAt: string;
}

export interface ArtifactDetailView {
  readonly artifact: ArtifactSummaryView;
  readonly version: ArtifactVersionView;
  readonly content: string;
}

export type SearchResultView = {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationTitle: string;
  readonly role: 'user' | 'assistant';
  /** HTML-escaped, `<mark>`-delimited excerpt; rendered as text segments. */
  readonly snippet: string;
  readonly at: string;
};
