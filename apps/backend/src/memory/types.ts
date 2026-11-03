/**
 * H-030 (#30) memory vocabulary and public shapes.
 *
 * A Memory is an explicitly accepted fact owned by one user and scoped to one
 * Bot. `conversationId` is both the source conversation and the recall scope
 * while provenance is live; it becomes null only when the source is deleted
 * (D3). Ownership columns never cross the service boundary.
 */

/** Migration 0011 lifecycle. `deleted` is a tombstone, not a hard delete. */
export type MemoryStatus = 'proposed' | 'accepted' | 'deleted';

/** Provenance survives source deletion only as `tombstoned` (D3). */
export type MemoryProvenanceState = 'live' | 'tombstoned';

/** A Memory as exposed to its owner. */
export interface Memory {
  id: string;
  botId: string;
  /** Source and recall-scope conversation; null once provenance is tombstoned. */
  conversationId: string | null;
  content: string;
  sourceMessageId: string | null;
  status: MemoryStatus;
  /** D2 gate, off by default. */
  botApproved: boolean;
  /** D2 gate, off by default. */
  conversationApproved: boolean;
  provenanceState: MemoryProvenanceState;
  provenanceTombstonedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** Internal row shape. Never crosses the service API. */
export interface MemoryRecord extends Memory {
  ownerUserId: string;
}

export interface ProposeMemoryInput {
  /**
   * Bot the fact belongs to. The proposal is rejected unless the source
   * conversation belongs to the same owner and Bot.
   */
  botId: string;
  /** Live, owned source conversation. Cross-conversation memory is not inferred. */
  conversationId: string;
  /** Optional message inside `conversationId`. */
  sourceMessageId?: string | null;
  /** Fact text; trimmed server-side, 1-4,000 code points. */
  content: string;
}

/** Normalized proposal handed to the repository. */
export interface ProposeMemoryRecord {
  botId: string;
  conversationId: string;
  sourceMessageId: string | null;
  content: string;
}

export interface RecallMemoriesOptions {
  botId: string;
  conversationId: string;
  limit?: number;
}

export interface ListMemoriesOptions {
  /** Restrict to one owned Bot. */
  botId?: string;
  /** Restrict to one owned source/recall conversation. */
  conversationId?: string;
  /** Restrict to one lifecycle state; defaults to every non-deleted Memory. */
  status?: MemoryStatus;
  /** Page size, 1-100; defaults to 50. */
  limit?: number;
  /** Zero-based offset for deterministic created-at-descending pages. */
  offset?: number;
}

/** Source identifiers whose deletion must be processed by D3. */
export interface SourceDeletedInput {
  conversationId: string;
  /** When present, only memories sourced from this exact message are affected. */
  sourceMessageId?: string | null;
}

/** D3 outcome: accepted memories retained, unaccepted proposals removed. */
export interface SourceDeletionResult {
  retainedMemoryIds: string[];
  removedMemoryIds: string[];
}

export type MemoryAuditAction =
  | 'propose'
  | 'approve_bot'
  | 'revoke_bot'
  | 'approve_conversation'
  | 'revoke_conversation'
  | 'accept'
  | 'delete'
  | 'source_delete';

export interface MemoryAuditEntry {
  id: string;
  memoryId: string;
  action: MemoryAuditAction;
  actorUserId: string;
  note: string;
  createdAt: string;
}
