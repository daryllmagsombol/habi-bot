import type { Pool } from 'pg';
import { BotRepository } from './bot-repository.js';
import type {
  BotPage,
  BotProfile,
  CreateBotInput,
  ListBotsOptions,
  UpdateBotInput,
} from './types.js';

/**
 * H-024 Bot profile service. Every method takes the authenticated actor id from
 * the session boundary, never from a request body, and delegates to an
 * owner-scoped repository query.
 *
 * HTTP endpoints, session-to-actor mapping, UI, instruction versioning, and
 * capability/exposure checks are integration work owned elsewhere. This class
 * stores Markdown as untrusted text only.
 */
export class BotService {
  private readonly repository: BotRepository;

  constructor(pool: Pool) {
    this.repository = new BotRepository(pool);
  }

  create(actorUserId: string, input: CreateBotInput): Promise<BotProfile> {
    return this.repository.create(actorUserId, input);
  }

  update(
    actorUserId: string,
    botId: string,
    input: UpdateBotInput,
  ): Promise<BotProfile> {
    return this.repository.update(actorUserId, botId, input);
  }

  get(actorUserId: string, botId: string): Promise<BotProfile> {
    return this.repository.get(actorUserId, botId);
  }

  list(actorUserId: string, options: ListBotsOptions = {}): Promise<BotPage> {
    return this.repository.list(actorUserId, options);
  }

  archive(actorUserId: string, botId: string): Promise<BotProfile> {
    return this.repository.archive(actorUserId, botId);
  }
}
