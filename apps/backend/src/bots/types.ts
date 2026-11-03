/** Bot profile persistence shapes for H-024 (#24). */

/** H-002 §3.2 lifecycle. `deleted` is a tombstone reserved for a later path. */
export type BotStatus = 'active' | 'archived';

/** A Bot as exposed to its owner. Ownership columns never cross this boundary. */
export interface BotProfile {
  id: string;
  name: string;
  description: string;
  /** Optional display reference, never an authorization key. */
  avatarRef: string | null;
  /** Untrusted Markdown guidance; never parsed into permissions. */
  instructionsMarkdown: string;
  status: BotStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One owner-scoped page, newest updated first. */
export interface BotPage {
  bots: BotProfile[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

export interface CreateBotInput {
  /** Trimmed server-side; 1-80 characters after trimming. */
  name: string;
  /** Defaults to `''`; at most 500 characters. */
  description?: string;
  /** Defaults to `null`; at most 512 trimmed characters when present. */
  avatarRef?: string | null;
  /** Defaults to `''`; untrusted Markdown, at most 20,000 characters. */
  instructionsMarkdown?: string;
}

/**
 * Patch semantics: `undefined` leaves a field unchanged. A `null` description
 * or instructions value clears it to `''`; a `null` avatar clears the
 * reference. Ownership and lifecycle fields are never patchable.
 */
export interface UpdateBotInput {
  name?: string;
  description?: string | null;
  avatarRef?: string | null;
  instructionsMarkdown?: string | null;
}

export interface ListBotsOptions {
  /** Defaults to active and archived Bots; deleted rows never list. */
  status?: BotStatus;
  limit?: number;
  /** Opaque cursor from a previous `BotPage`. */
  cursor?: string;
}

/** Normalized, validated input handed to the repository. */
export interface CreateBotRecord {
  name: string;
  description: string;
  avatarRef: string | null;
  instructionsMarkdown: string;
}

/** Normalized patch; only present keys are changed. */
export interface UpdateBotRecord {
  name?: string;
  description?: string;
  avatarRef?: string | null;
  instructionsMarkdown?: string;
}
