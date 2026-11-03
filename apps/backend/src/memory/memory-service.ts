/**
 * H-030 (#30) MemoryService: explicit, owner-scoped memory controls.
 *
 * Invariants:
 *   - Every method takes the authenticated actor id from the session boundary.
 *     No method accepts an owner id from input.
 *   - A Memory is created only by `propose` and only from a live, owned
 *     conversation under the named active owned Bot. Nothing is inferred from
 *     one conversation into another.
 *   - Recall requires an explicitly accepted row, BOTH the per-Bot and
 *     per-conversation gates (D2, both default off), live provenance, and the
 *     exact same Bot and conversation. Neither gate alone recalls anything.
 *   - Source deletion (D3) retains accepted Memories with nulled/tombstoned
 *     provenance and an audit row; unaccepted proposals are removed. Explicit
 *     deletion stops recall immediately.
 *   - Foreign, guessed, malformed, tombstoned, or archived-scope identifiers
 *     fail closed with one not-found result.
 *
 * HTTP routes, UI, retention/purge, ranking, embeddings, and export (#32) are
 * out of scope for this slice. Memory content is untrusted display text and
 * never grants a capability or changes Bot policy.
 */
import type { Pool } from 'pg';
import { loadOwnedConversation } from '../persistence/rows.js';
import { MemoryRepository } from './memory-repository.js';
import type {
  ListMemoriesOptions,
  Memory,
  ProposeMemoryInput,
  RecallMemoriesOptions,
  SourceDeletionResult,
  SourceDeletedInput,
} from './types.js';
import {
  normalizeApprovalFlag,
  normalizeProposeMemoryInput,
  normalizeRecallMemoriesOptions,
} from './validation.js';

export class MemoryService {
  private readonly repository: MemoryRepository;
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
    this.repository = new MemoryRepository(pool);
  }

  /** Creates a proposed Memory. It is not recallable until both gates and acceptance. */
  propose(actorUserId: string, input: ProposeMemoryInput): Promise<Memory> {
    return this.repository.propose(
      actorUserId,
      normalizeProposeMemoryInput(input),
    );
  }

  /** Owner-scoped inspect of one live Memory, including both gate states. */
  get(actorUserId: string, memoryId: string): Promise<Memory> {
    return this.repository.get(actorUserId, memoryId);
  }

  /**
   * Turns the per-Bot D2 gate on. The default for the setter form is off, so a
   * caller cannot enable recall by omitting the argument.
   */
  approveBot(actorUserId: string, memoryId: string): Promise<Memory> {
    return this.repository.setApproval(actorUserId, memoryId, 'bot', true);
  }

  /** Sets or clears the per-Bot D2 gate; the omitted default is off. */
  setBotApprovalDefault(
    actorUserId: string,
    memoryId: string,
    approved: boolean = false,
  ): Promise<Memory> {
    return this.repository.setApproval(
      actorUserId,
      memoryId,
      'bot',
      normalizeApprovalFlag(approved),
    );
  }

  /**
   * Turns the per-conversation D2 gate on. This gate is scoped to the Memory's
   * own source/recall conversation and never authorizes another conversation.
   */
  approveConversation(actorUserId: string, memoryId: string): Promise<Memory> {
    return this.repository.setApproval(
      actorUserId,
      memoryId,
      'conversation',
      true,
    );
  }

  /** Sets or clears the per-conversation D2 gate; the omitted default is off. */
  setConversationApproval(
    actorUserId: string,
    memoryId: string,
    approved: boolean = false,
  ): Promise<Memory> {
    return this.repository.setApproval(
      actorUserId,
      memoryId,
      'conversation',
      normalizeApprovalFlag(approved),
    );
  }

  /** Explicit acceptance. Both gates must already be on. */
  accept(actorUserId: string, memoryId: string): Promise<Memory> {
    return this.repository.accept(actorUserId, memoryId);
  }

  /**
   * Owner-scoped recall. The conversation must be live and owned, and must
   * belong to the requested Bot; otherwise the result is the same not-found as
   * a foreign id.
   */
  async recall(
    actorUserId: string,
    options: RecallMemoriesOptions,
  ): Promise<Memory[]> {
    const normalized = normalizeRecallMemoriesOptions(options);
    const conversation = await loadOwnedConversation(
      this.pool,
      actorUserId,
      normalized.conversationId,
    );

    if (conversation.bot_id !== normalized.botId) {
      // A conversation under another Bot is never a recall scope for this one.
      return [];
    }

    return this.repository.recall(actorUserId, normalized);
  }

  /** Owner-scoped inspect/listing, including proposed, accepted, and filtered tombstones. */
  list(actorUserId: string, options: ListMemoriesOptions = {}): Promise<Memory[]> {
    return this.repository.list(actorUserId, options);
  }

  /** Explicit owner deletion. Recall stops immediately; the row is a tombstone. */
  delete(actorUserId: string, memoryId: string): Promise<Memory> {
    return this.repository.delete(actorUserId, memoryId);
  }

  /**
   * D3 hook for conversation/message deletion. Accepted Memories survive with
   * provenance nulled/tombstoned plus audit; unaccepted proposals are removed.
   * This method does not delete conversations or messages itself.
   */
  onSourceDeleted(
    actorUserId: string,
    input: SourceDeletedInput,
  ): Promise<SourceDeletionResult> {
    return this.repository.onSourceDeleted(actorUserId, input);
  }
}
