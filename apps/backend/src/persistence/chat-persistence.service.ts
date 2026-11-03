import type { Pool } from 'pg';
import { ConversationRepository } from './conversation-repository.js';
import { MessageRepository } from './message-repository.js';

/**
 * Persistence facade for the two H-019 aggregates. Wiring (Nest provider,
 * guards, pool lifecycle) is a later integration step; this class only exposes
 * actor-scoped repositories.
 */
export class ChatPersistenceService {
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;

  constructor(private readonly pool: Pool) {
    this.conversations = new ConversationRepository(pool);
    this.messages = new MessageRepository(pool);
  }

  /** Closes the supplied pool; intended for process shutdown and tests. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
