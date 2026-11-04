/**
 * Composition service for the P1 chat surface (H-018).
 *
 * It wires existing owner-scoped repositories into the shapes the chat client
 * needs. It adds no authorization rule of its own: every method takes the actor
 * id from the validated session and every read/write carries that id into the
 * repository predicate.
 *
 * Deliberately not wired here:
 *   - model/provider dispatch (RunService.createRun calls a HarnessAdapter);
 *   - streaming provider output, artifacts, attachments, memory writes;
 *   - conversation creation/rename (the UI can use an existing thread).
 *
 * `POST /api/threads/:id/messages` reserves a durable `queued` Run through the
 * existing RunRepository, so the client gets a stable run id and can replay
 * events. Dispatch is the same gap made explicit: it needs a harness adapter
 * and a provider call, which this surface is forbidden to make.
 */
import type { Message } from '@habi/contracts';
import type { Pool } from 'pg';
import { BotRepository } from '../bots/bot-repository.js';
import type { BotProfile, ListBotsOptions } from '../bots/types.js';
import { RunEventStore } from '../events/run-event-store.js';
import { RunEventStream } from '../events/run-event-stream.js';
import { ConversationRepository } from '../persistence/conversation-repository.js';
import {
  PersistenceConflictError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { MessageRepository } from '../persistence/message-repository.js';
import type { ListMessagesOptions } from '../persistence/types.js';
import { RunRepository, toRunView } from '../runs/run-repository.js';
import { isTerminalRunStatus } from '../runs/types.js';
import type { RunView } from '../runs/types.js';
import { unknownUsage } from '../runs/usage.js';
import { fingerprintRunRequest } from '../runs/validation.js';
import { ApiError } from './api-errors.js';
import {
  purposeFragment,
  type BotDetail,
  type BotSummary,
} from './api-projection.js';
import {
  ApiProjectionRepository,
  type BotThreadPage,
  type ListBotThreadsOptions,
} from './api-repository.js';

const RUN_IDEMPOTENCY_PREFIX = 'api-message:';

export interface BotListPage {
  bots: BotSummary[];
  nextCursor: string | null;
}

export interface PostMessageResult {
  message: Message;
  /** Same value as `run.id`; explicit for clients that only need the handle. */
  runId: string;
  /** Dry reservation only: `dispatchState` is `not_dispatched` until a worker exists. */
  run: RunView;
}

interface MessageBody {
  content: string;
  clientMessageId?: string;
}

function readMessageBody(body: unknown): MessageBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PersistenceValidationError('invalid_input');
  }

  const record = body as Record<string, unknown>;
  const content = record.content;

  if (typeof content !== 'string' || content.length === 0) {
    throw new PersistenceValidationError('invalid_input');
  }

  // Client-supplied ids and owners are never read. Only the idempotency key for
  // this one message is accepted, and it is scoped by the repository to the
  // conversation and actor.
  const rawClientMessageId = record.clientMessageId;

  if (rawClientMessageId === undefined) {
    return { content };
  }

  if (
    typeof rawClientMessageId !== 'string' ||
    rawClientMessageId.length === 0 ||
    rawClientMessageId.length > 200
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return { content, clientMessageId: rawClientMessageId };
}

export class ApiService {
  private readonly bots: BotRepository;
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly runs: RunRepository;
  private readonly projections: ApiProjectionRepository;
  private readonly eventStore: RunEventStore;

  constructor(pool: Pool) {
    this.bots = new BotRepository(pool);
    this.conversations = new ConversationRepository(pool);
    this.messages = new MessageRepository(pool);
    this.runs = new RunRepository(pool);
    this.projections = new ApiProjectionRepository(pool);
    this.eventStore = new RunEventStore(pool);
  }

  get events(): RunEventStore {
    return this.eventStore;
  }

  /** A new stream instance per connection: dedupe state is per consumer. */
  createStream(): RunEventStream {
    return new RunEventStream(this.eventStore);
  }

  async listBots(
    actorUserId: string,
    options: ListBotsOptions = {},
  ): Promise<BotListPage> {
    const page = await this.bots.list(actorUserId, options);
    const activity = await this.projections.conversationActivity(
      actorUserId,
      page.bots.map((bot) => bot.id),
    );

    return {
      bots: page.bots.map((bot) => this.toSummary(bot, activity.get(bot.id))),
      nextCursor: page.nextCursor,
    };
  }

  async getBot(actorUserId: string, botId: string): Promise<BotDetail> {
    const bot = await this.bots.get(actorUserId, botId);
    const activity = await this.projections.conversationActivity(actorUserId, [
      bot.id,
    ]);
    const counts = activity.get(bot.id);

    return {
      bot,
      purpose: purposeFragment(bot),
      conversationCount: counts?.conversationCount ?? 0,
      lastActivityAt: counts?.lastActivityAt ?? bot.updatedAt,
    };
  }

  async listThreads(
    actorUserId: string,
    botId: string,
    options: ListBotThreadsOptions = {},
  ): Promise<BotThreadPage> {
    // Ownership first: a foreign or unknown Bot is not found, never an empty list.
    await this.bots.get(actorUserId, botId);

    return this.projections.listBotThreads(actorUserId, botId, options);
  }

  listMessages(
    actorUserId: string,
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<{
    messages: Message[];
    beforeCursor: string | null;
    afterCursor: string | null;
    hasMoreBefore: boolean;
    hasMoreAfter: boolean;
  }> {
    return this.messages.list(actorUserId, conversationId, options);
  }

  async postMessage(
    actorUserId: string,
    conversationId: string,
    body: unknown,
  ): Promise<PostMessageResult> {
    const input = readMessageBody(body);

    // Resolve ownership and the Bot lifecycle before writing anything, so a
    // message is never persisted for an archived Bot's conversation.
    const conversation = await this.conversations.get(actorUserId, conversationId);
    const bot = await this.bots.get(actorUserId, conversation.botId);

    if (bot.status !== 'active') {
      throw new PersistenceConflictError('bot_unavailable');
    }

    // Persisting the owner's message also proves the conversation is active.
    const message = await this.messages.append(actorUserId, {
      conversationId,
      role: 'user',
      content: input.content,
      ...(input.clientMessageId === undefined
        ? {}
        : { clientMessageId: input.clientMessageId }),
    });

    // The message id makes the reservation idempotent for a retried client key:
    // a replay returns the same message and therefore the same Run.
    const idempotencyKey = `${RUN_IDEMPOTENCY_PREFIX}${message.id}`;
    const requestFingerprint = fingerprintRunRequest({
      conversationId,
      botId: conversation.botId,
      messages: [
        {
          role: 'user',
          content: message.content,
          messageId: message.id,
        },
      ],
    });

    let run = await this.runs.findByIdempotencyKey(actorUserId, idempotencyKey);

    if (run === null) {
      run = await this.runs.insertQueued({
        ownerUserId: actorUserId,
        conversationId,
        idempotencyKey,
        requestFingerprint,
      });

      // A concurrent submitter may have won the unique constraint.
      run ??= await this.runs.findByIdempotencyKey(actorUserId, idempotencyKey);
    }

    if (run === null) {
      throw new Error('Run reservation disappeared after creation.');
    }

    return { message, runId: run.id, run: toRunView(run) };
  }

  /**
   * Owner-scoped, idempotent cancellation for a Run that has not been dispatched.
   *
   * A Run that may already have executed cannot be cancelled correctly without
   * asking the harness to stop; no adapter is wired here, so the surface reports
   * `cancel_unavailable` instead of pretending the provider stopped. A terminal
   * Run is returned unchanged, which makes repeated calls idempotent.
   */
  async cancelRun(actorUserId: string, runId: string): Promise<RunView> {
    const current = await this.runs.loadOwnedRun(actorUserId, runId);

    if (isTerminalRunStatus(current.status)) {
      return toRunView(current);
    }

    if (current.dispatch_state !== 'not_dispatched') {
      throw new ApiError('cancel_unavailable');
    }

    const updated = await this.runs.terminalize({
      runId: current.id,
      ownerUserId: actorUserId,
      status: 'cancelled',
      dispatchState: null,
      errorCode: null,
      usage: unknownUsage(),
      lastEventSeq: 0,
      startExecution: false,
    });

    const finalRun =
      updated ?? (await this.runs.loadOwnedRun(actorUserId, runId));

    return toRunView(finalRun);
  }

  private toSummary(
    bot: BotProfile,
    activity: { conversationCount: number; lastActivityAt: string | null } | undefined,
  ): BotSummary {
    return {
      id: bot.id,
      name: bot.name,
      purpose: purposeFragment(bot),
      status: bot.status,
      avatarRef: bot.avatarRef,
      conversationCount: activity?.conversationCount ?? 0,
      lastActivityAt: activity?.lastActivityAt ?? bot.updatedAt,
      updatedAt: bot.updatedAt,
    };
  }
}
