/**
 * Rebuilds the `CreateRunRequest` for a Run that was reserved earlier by the
 * API.
 *
 * `runs` stores the reservation and the idempotency/fingerprint authority, not
 * the request body. The H-018 surface writes `api-message:<messageId>` as the
 * key, so the same message can be re-read under the owner predicate and the
 * conversation history up to that message is the Habi-selected context. Bot
 * identity comes from the owned conversation; deadline and budget use the same
 * controller defaults the API would have applied.
 *
 * A Run with no resolvable context is a permanent input failure: it is
 * terminalized as `failed` / `invalid_request` without calling the adapter.
 */
import type {
  ChatMessage,
  CreateRunRequest,
  Id,
} from '../adapters/harness-adapter.js';
import type { RunRow } from '../runs/run-repository.js';
import {
  DEFAULT_DEADLINE_MS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from '../runs/index.js';
import type { WorkerRunRepository } from './run-claim-repository.js';

/** A Run whose persisted context cannot produce a provider request. */
export class RunContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunContextError';
  }
}

function asId<T>(value: string): Id<T> {
  return value as Id<T>;
}

export async function buildCreateRunRequest(
  repository: WorkerRunRepository,
  run: RunRow,
  now: () => number,
): Promise<CreateRunRequest> {
  const botId = await repository.loadConversationBot(
    run.owner_user_id,
    run.conversation_id,
  );

  if (botId === null) {
    throw new RunContextError('the Run conversation is missing or not owned');
  }

  const rows = await repository.loadContextMessages(
    run.owner_user_id,
    run.conversation_id,
    run.id,
    run.idempotency_key,
  );

  if (rows.length === 0) {
    throw new RunContextError('the Run has no persisted context message');
  }

  const messages = rows.map(
    (row): ChatMessage => ({
      role: row.role,
      content: row.content,
      messageId: asId<'Message'>(row.id),
    }),
  );

  return {
    runId: asId<'Run'>(run.id),
    idempotencyKey: run.idempotency_key,
    correlationId: run.id,
    ownerUserId: asId<'User'>(run.owner_user_id),
    conversationId: asId<'Conversation'>(run.conversation_id),
    botId: asId<'Bot'>(botId),
    messages,
    deadlineAt: new Date(now() + DEFAULT_DEADLINE_MS).toISOString(),
    tokenBudget: {
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    },
    allowedTools: [],
  };
}
