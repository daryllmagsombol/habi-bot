/**
 * Composition service for the P1 chat surface (H-018).
 *
 * It wires existing owner-scoped repositories into the shapes the chat client
 * needs. It adds no authorization rule of its own: every method takes the actor
 * id from the validated session and every read/write carries that id into the
 * repository predicate.
 *
 * Deliberately not wired here:
 *   - model/provider dispatch (the worker claims and dispatches through
 *     `RunService.dispatchReserved`);
 *   - streaming provider output, artifacts, attachments, memory writes;
 *   - conversation creation/rename (the UI can use an existing thread).
 *
 * `POST /api/threads/:id/messages` persists the message, reserves the daily
 * allowance for a server-generated Run id, then writes the durable `queued` Run.
 * The reservation is keyed by that id and by the message-derived idempotency
 * key, so a retried client key reuses the same Run and is charged once. If
 * admission is refused, no Run row is written and nothing is claimable.
 */
import type { Conversation, Message } from '@habi/contracts';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ArtifactService } from '../artifacts/artifact-service.js';
import type {
  ArtifactDetail,
  ArtifactKind,
  ArtifactPage,
  ArtifactVersionPage,
  CreateArtifactInput,
  UpdateArtifactInput,
  WritableArtifactStatus,
} from '../artifacts/types.js';
import { BotRepository } from '../bots/bot-repository.js';
import type {
  BotProfile,
  CreateBotInput,
  ListBotsOptions,
  UpdateBotInput,
} from '../bots/types.js';
import { MemoryService } from '../memory/memory-service.js';
import type { Memory } from '../memory/types.js';
import { SearchService } from '../search/search-service.js';
import type { MessageSearchHit } from '../search/types.js';
import { SkillService } from '../skills/skill-service.js';
import type {
  Skill,
  SkillPage,
  SkillStatus,
  UpdateSkillInput,
} from '../skills/types.js';
import { RunEventStore } from '../events/run-event-store.js';
import { RunEventStream } from '../events/run-event-stream.js';
import { UsageLimitService } from '../limits/usage-limit-service.js';
import { ConversationRepository } from '../persistence/conversation-repository.js';
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { MessageRepository } from '../persistence/message-repository.js';
import type { ListMessagesOptions } from '../persistence/types.js';
import { RunRepository, toRunView } from '../runs/run-repository.js';
import { isTerminalRunStatus } from '../runs/types.js';
import type { RunView } from '../runs/types.js';
import { fingerprintRunRequest } from '../runs/validation.js';
import { unknownUsage } from '../runs/usage.js';
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

/** Memory listing is offset based in the service; the HTTP cursor wraps it. */
const MEMORY_CURSOR_PREFIX = 'mem1.';
const MAX_MEMORY_CURSOR_LENGTH = 256;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Provisional per-message admission bound. The acceptance design leaves the
 * per-request cap open (design §8.2), so this is an admission estimate, not a
 * claim that a Run cannot exceed it: the hold is settled to reported usage at
 * terminal, and an overrun is recorded honestly.
 */
const RUN_ALLOWANCE_ESTIMATE_TOKENS = 10_000;

export interface BotListPage {
  bots: BotSummary[];
  nextCursor: string | null;
}

export interface PostMessageResult {
  message: Message;
  /** Same value as `run.id`; explicit for clients that only need the handle. */
  runId: string;
  /** Reserved Run: `dispatchState` stays `not_dispatched` until the worker claims it. */
  run: RunView;
}

export interface MemoryListPage {
  memories: Memory[];
  nextCursor: string | null;
}

export interface SearchResultPage {
  results: MessageSearchHit[];
  nextCursor: string | null;
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

/**
 * JSON bodies are untrusted data. A missing or non-object body is the same
 * `invalid_input` the repositories use; unknown fields are simply not read, so
 * a body cannot name an owner, id, or lifecycle it is not allowed to set.
 */
function readObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return body as Record<string, unknown>;
}

function readOptionalField<T>(
  record: Record<string, unknown>,
  key: string,
): T | undefined {
  const value = record[key];

  return value === undefined ? undefined : (value as T);
}

function encodeMemoryCursor(offset: number, botId: string): string {
  return `${MEMORY_CURSOR_PREFIX}${Buffer.from(
    JSON.stringify({ o: offset, b: botId }),
    'utf8',
  ).toString('base64url')}`;
}

/**
 * The memory service lists with a deterministic `created_at DESC, id DESC`
 * offset, so the HTTP cursor is an opaque offset bound to the Bot filter.
 * Reusing it for another Bot is a malformed request, not a silent re-page.
 */
function decodeMemoryCursor(cursor: string, botId: string): number {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > MAX_MEMORY_CURSOR_LENGTH ||
    !cursor.startsWith(MEMORY_CURSOR_PREFIX)
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const encoded = cursor.slice(MEMORY_CURSOR_PREFIX.length);

  if (!BASE64URL_PATTERN.test(encoded)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new PersistenceValidationError('invalid_cursor');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  const { o, b } = parsed as Record<string, unknown>;

  if (
    typeof o !== 'number' ||
    !Number.isSafeInteger(o) ||
    o < 0 ||
    b !== botId
  ) {
    throw new PersistenceValidationError('invalid_cursor');
  }

  return o;
}

export class ApiService {
  private readonly bots: BotRepository;
  private readonly conversations: ConversationRepository;
  private readonly messages: MessageRepository;
  private readonly runs: RunRepository;
  private readonly projections: ApiProjectionRepository;
  private readonly eventStore: RunEventStore;
  private readonly limits: UsageLimitService;
  private readonly artifacts: ArtifactService;
  private readonly memories: MemoryService;
  private readonly skills: SkillService;
  private readonly search: SearchService;

  constructor(pool: Pool) {
    this.bots = new BotRepository(pool);
    this.conversations = new ConversationRepository(pool);
    this.messages = new MessageRepository(pool);
    this.runs = new RunRepository(pool);
    this.projections = new ApiProjectionRepository(pool);
    this.eventStore = new RunEventStore(pool);
    this.limits = new UsageLimitService(pool);
    this.artifacts = new ArtifactService(pool);
    this.memories = new MemoryService(pool);
    this.skills = new SkillService(pool);
    this.search = new SearchService(pool);
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

  /** Creates an active Bot owned by the session actor. The id is server-owned. */
  async createBot(
    actorUserId: string,
    body: unknown,
  ): Promise<{ bot: BotProfile }> {
    const record = readObjectBody(body);
    const name = record.name;

    if (typeof name !== 'string') {
      throw new PersistenceValidationError('invalid_input');
    }

    const description = readOptionalField<string>(record, 'description');
    const instructionsMarkdown = readOptionalField<string>(
      record,
      'instructionsMarkdown',
    );
    const input: CreateBotInput = {
      name,
      ...(description === undefined ? {} : { description }),
      ...(instructionsMarkdown === undefined ? {} : { instructionsMarkdown }),
    };

    return { bot: await this.bots.create(actorUserId, input) };
  }

  /**
   * Applies a partial update to an owned Bot. Only profile fields named by the
   * chat contract are read; ids, owners, and lifecycle fields are ignored.
   */
  async updateBot(
    actorUserId: string,
    botId: string,
    body: unknown,
  ): Promise<{ bot: BotProfile }> {
    const record = readObjectBody(body);
    const name = readOptionalField<string>(record, 'name');
    const description = readOptionalField<string | null>(record, 'description');
    const instructionsMarkdown = readOptionalField<string | null>(
      record,
      'instructionsMarkdown',
    );
    const input: UpdateBotInput = {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(instructionsMarkdown === undefined ? {} : { instructionsMarkdown }),
    };

    if (
      input.name === undefined &&
      input.description === undefined &&
      input.instructionsMarkdown === undefined
    ) {
      throw new PersistenceValidationError('invalid_input');
    }

    return { bot: await this.bots.update(actorUserId, botId, input) };
  }

  /** Archives an owned Bot. Repeating the call is idempotent. */
  async archiveBot(
    actorUserId: string,
    botId: string,
  ): Promise<{ bot: BotProfile }> {
    return { bot: await this.bots.archive(actorUserId, botId) };
  }

  /** Creates a conversation under an owned active Bot. */
  async createThread(
    actorUserId: string,
    botId: string,
    body: unknown,
  ): Promise<{ thread: Conversation }> {
    const record = readObjectBody(body);
    const title = record.title;

    if (title !== undefined && typeof title !== 'string') {
      throw new PersistenceValidationError('invalid_input');
    }

    const thread = await this.conversations.create(actorUserId, {
      botId,
      ...(title === undefined ? {} : { title }),
    });

    return { thread };
  }

  /** Renames an owned conversation. */
  async renameThread(
    actorUserId: string,
    threadId: string,
    body: unknown,
  ): Promise<{ thread: Conversation }> {
    const record = readObjectBody(body);
    const title = record.title;

    if (typeof title !== 'string') {
      throw new PersistenceValidationError('invalid_input');
    }

    return { thread: await this.conversations.rename(actorUserId, threadId, title) };
  }

  /** Tombstones an owned conversation. Repeating the call is idempotent. */
  async deleteThread(
    actorUserId: string,
    threadId: string,
  ): Promise<{ thread: Conversation }> {
    return { thread: await this.conversations.delete(actorUserId, threadId) };
  }

  /** One bounded page of owned artifacts, newest first. */
  listArtifacts(
    actorUserId: string,
    options: { conversationId?: string; limit?: number; cursor?: string } = {},
  ): Promise<ArtifactPage> {
    return this.artifacts.list(actorUserId, options);
  }

  /** Creates one artifact and its version 1. */
  async createArtifact(
    actorUserId: string,
    body: unknown,
  ): Promise<{ artifact: ArtifactDetail }> {
    const record = readObjectBody(body);
    const conversationId = readOptionalField<string | null>(
      record,
      'conversationId',
    );
    const runId = readOptionalField<string | null>(record, 'runId');
    const status = readOptionalField<WritableArtifactStatus>(record, 'status');
    const input: CreateArtifactInput = {
      kind: record.kind as ArtifactKind,
      title: record.title as string,
      content: record.content as string,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(runId === undefined ? {} : { runId }),
      ...(status === undefined ? {} : { status }),
    };

    return { artifact: await this.artifacts.create(actorUserId, input) };
  }

  /** Reads the current version, or one exact historical version. */
  async getArtifact(
    actorUserId: string,
    artifactId: string,
    version: number | undefined,
  ): Promise<{ artifact: ArtifactDetail }> {
    return {
      artifact: await this.artifacts.get(
        actorUserId,
        artifactId,
        version === undefined ? {} : { version },
      ),
    };
  }

  /**
   * Appends a version. A body that changes only metadata keeps the current body
   * text, because the service always writes a complete version snapshot.
   */
  async updateArtifact(
    actorUserId: string,
    artifactId: string,
    body: unknown,
  ): Promise<{ artifact: ArtifactDetail }> {
    const record = readObjectBody(body);
    const content = readOptionalField<string>(record, 'content');
    const title = readOptionalField<string>(record, 'title');
    const kind = readOptionalField<ArtifactKind>(record, 'kind');
    const status = readOptionalField<WritableArtifactStatus>(record, 'status');

    if (
      content === undefined &&
      title === undefined &&
      kind === undefined &&
      status === undefined
    ) {
      throw new PersistenceValidationError('invalid_input');
    }

    // Ownership and the current hash-verified body are resolved before the
    // append, so a metadata-only patch never reads a foreign artifact.
    const nextContent =
      content ?? (await this.artifacts.get(actorUserId, artifactId)).version.content;
    const input: UpdateArtifactInput = {
      content: nextContent,
      ...(title === undefined ? {} : { title }),
      ...(kind === undefined ? {} : { kind }),
      ...(status === undefined ? {} : { status }),
    };

    return { artifact: await this.artifacts.update(actorUserId, artifactId, input) };
  }

  /** One bounded page of version metadata, newest first. */
  listArtifactVersions(
    actorUserId: string,
    artifactId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<ArtifactVersionPage> {
    return this.artifacts.listVersions(actorUserId, artifactId, options);
  }

  /** Restores a recorded version as a new appended version. */
  async restoreArtifactVersion(
    actorUserId: string,
    artifactId: string,
    body: unknown,
  ): Promise<{ artifact: ArtifactDetail }> {
    const record = readObjectBody(body);

    return {
      artifact: await this.artifacts.restoreVersion(
        actorUserId,
        artifactId,
        record.version as number,
      ),
    };
  }

  /** One bounded page of memories under an owned Bot. */
  async listMemories(
    actorUserId: string,
    botId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<MemoryListPage> {
    // A foreign or unknown Bot id is not an empty page.
    await this.bots.get(actorUserId, botId);

    const limit = options.limit ?? 50;
    const offset =
      options.cursor === undefined
        ? 0
        : decodeMemoryCursor(options.cursor, botId);
    const rows = await this.memories.list(actorUserId, {
      botId,
      limit: limit + 1,
      offset,
    });
    let hasMore = rows.length > limit;

    // The service caps a page at 100, so `limit + 1` saturates at the ceiling.
    // One bounded probe keeps the has-more answer correct at that edge.
    if (!hasMore && limit >= 100 && rows.length === limit) {
      hasMore =
        (
          await this.memories.list(actorUserId, {
            botId,
            limit: 1,
            offset: offset + limit,
          })
        ).length > 0;
    }

    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      memories: page,
      nextCursor: hasMore
        ? encodeMemoryCursor(offset + page.length, botId)
        : null,
    };
  }

  /**
   * Proposes a Memory from one live owned thread under the Bot. The service
   * enforces that the thread belongs to the same owner and Bot, so a foreign
   * or mismatched scope is the same not-found as a guessed id.
   */
  async createMemory(
    actorUserId: string,
    botId: string,
    body: unknown,
  ): Promise<{ memory: Memory }> {
    const record = readObjectBody(body);
    const text = record.text;
    const threadId = record.threadId;

    if (
      typeof text !== 'string' ||
      typeof threadId !== 'string' ||
      threadId.length === 0
    ) {
      throw new PersistenceValidationError('invalid_input');
    }

    return {
      memory: await this.memories.propose(actorUserId, {
        botId,
        conversationId: threadId,
        content: text,
      }),
    };
  }

  /**
   * Sets both D2 gates and, when both are on, records explicit acceptance.
   * The service still decides whether acceptance is legal; nothing here can
   * make a Memory recallable with one gate, a foreign thread, or dead
   * provenance.
   */
  async setMemoryApprovals(
    actorUserId: string,
    memoryId: string,
    body: unknown,
  ): Promise<{ memory: Memory }> {
    const record = readObjectBody(body);
    const bot = record.bot;
    const thread = record.thread;
    const threadId = readOptionalField<string>(record, 'threadId');

    if (typeof bot !== 'boolean' || typeof thread !== 'boolean') {
      throw new PersistenceValidationError('invalid_input');
    }

    if (threadId !== undefined) {
      const memory = await this.memories.get(actorUserId, memoryId);

      if (memory.conversationId !== threadId) {
        // The approval is bound to this Memory's own thread; another thread
        // cannot approve it, even when the caller owns both.
        throw new PersistenceNotFoundError();
      }
    }

    await this.memories.setBotApprovalDefault(actorUserId, memoryId, bot);
    const memory = await this.memories.setConversationApproval(
      actorUserId,
      memoryId,
      thread,
    );

    if (bot && thread) {
      return { memory: await this.memories.accept(actorUserId, memoryId) };
    }

    return { memory };
  }

  /** One owner-scoped page of skills, optionally filtered by Bot/status. */
  async listSkills(
    actorUserId: string,
    options: { botId?: string; status?: SkillStatus; limit?: number; cursor?: string } = {},
  ): Promise<SkillPage> {
    // A Bot filter is an owned resource path, so a foreign/unknown id is 404
    // rather than an empty page.
    if (options.botId !== undefined) {
      await this.bots.get(actorUserId, options.botId);
    }

    return this.skills.list(actorUserId, options);
  }

  /** Creates a skill owned by the actor, optionally attached to one Bot. */
  async createSkill(
    actorUserId: string,
    body: unknown,
  ): Promise<{ skill: Skill }> {
    const record = readObjectBody(body);
    const description = readOptionalField<string>(record, 'description');
    const bodyMarkdown = readOptionalField<string>(record, 'bodyMarkdown');
    const botId = readOptionalField<string | null>(record, 'botId');

    return {
      skill: await this.skills.create(actorUserId, {
        name: record.name as string,
        ...(description === undefined ? {} : { description }),
        ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }),
        ...(botId === undefined ? {} : { botId }),
      }),
    };
  }

  async getSkill(
    actorUserId: string,
    skillId: string,
  ): Promise<{ skill: Skill }> {
    return { skill: await this.skills.get(actorUserId, skillId) };
  }

  /**
   * Applies a partial patch as a new immutable skill version.
   *
   * Ownership is resolved before the body is normalized, so a guessed, foreign,
   * malformed, or tombstoned id stays the same non-enumerating 404 regardless
   * of what the body contains. Omitted fields are not read, so the service
   * keeps the current value; it appends exactly one version and never rewrites
   * history. An archived skill is owned but read-only (`409 skill_unavailable`),
   * a name already used in the same owner/Bot scope is
   * `409 skill_name_conflict`, and an empty patch is `400 invalid_input`.
   */
  async updateSkill(
    actorUserId: string,
    skillId: string,
    body: unknown,
  ): Promise<{ skill: Skill }> {
    await this.skills.get(actorUserId, skillId);

    const record = readObjectBody(body);
    const name = readOptionalField<string>(record, 'name');
    const description = readOptionalField<string | null>(record, 'description');
    const bodyMarkdown = readOptionalField<string | null>(
      record,
      'bodyMarkdown',
    );
    const input: UpdateSkillInput = {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }),
    };

    return { skill: await this.skills.update(actorUserId, skillId, input) };
  }

  /** Attaches an owned live skill to an owned active Bot. */
  async attachSkill(
    actorUserId: string,
    skillId: string,
    body: unknown,
  ): Promise<{ skill: Skill }> {
    const record = readObjectBody(body);

    return {
      skill: await this.skills.attach(
        actorUserId,
        skillId,
        record.botId as string,
      ),
    };
  }

  /** Detaches an owned live skill from its Bot. */
  async detachSkill(
    actorUserId: string,
    skillId: string,
  ): Promise<{ skill: Skill }> {
    return { skill: await this.skills.detach(actorUserId, skillId) };
  }

  /** Owner-scoped message search; filters can only narrow the caller's set. */
  async searchMessages(
    actorUserId: string,
    input: { query: string; botId?: string; limit?: number; cursor?: string },
  ): Promise<SearchResultPage> {
    const page = await this.search.searchMessages({
      actorUserId,
      query: input.query,
      ...(input.botId === undefined ? {} : { botId: input.botId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    });

    return { results: page.hits, nextCursor: page.nextCursor };
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

    const existing = await this.runs.findByIdempotencyKey(
      actorUserId,
      idempotencyKey,
    );

    if (existing !== null) {
      return { message, runId: existing.id, run: toRunView(existing) };
    }

    // Admission reserves before the Run row exists. A crash in this window
    // leaves a hold but no dispatchable Run (fail closed); it never leaves a
    // Run that could dispatch without an allowance hold.
    const runId = randomUUID();
    const reservation = await this.limits.reserve({
      ownerUserId: actorUserId,
      runId,
      estimateTokens: RUN_ALLOWANCE_ESTIMATE_TOKENS,
    });

    let run;

    try {
      run = await this.runs.insertQueued({
        runId,
        ownerUserId: actorUserId,
        conversationId,
        idempotencyKey,
        requestFingerprint,
      });
    } catch (error) {
      await this.releaseQuietly(reservation.id, actorUserId);
      throw error;
    }

    if (run === null) {
      // A concurrent submitter won the unique constraint. Its own reservation
      // covers the Run, so this attempt's hold must be released rather than
      // counted twice.
      await this.releaseQuietly(reservation.id, actorUserId);

      const winner = await this.runs.findByIdempotencyKey(
        actorUserId,
        idempotencyKey,
      );

      if (winner === null) {
        throw new Error('Run reservation disappeared after a unique conflict.');
      }

      return { message, runId: winner.id, run: toRunView(winner) };
    }

    return { message, runId: run.id, run: toRunView(run) };
  }

  /** Best-effort release for a hold whose Run was not written. */
  private async releaseQuietly(
    reservationId: string,
    ownerUserId: string,
  ): Promise<void> {
    try {
      await this.limits.release(reservationId, { ownerUserId });
    } catch {
      // The hold is an admission failure artifact; the day boundary expires it.
      // It is never converted into committed usage.
    }
  }

  /**
   * Owner-scoped, idempotent cancellation.
   *
   * The API process has no adapter, so it never claims that a dispatched Run was
   * stopped. Instead it commits a durable cancellation intent on the Run row and
   * returns the Run's *current* state; whichever worker owns the claim observes
   * the intent on its next heartbeat, calls the adapter once, and terminalizes
   * through the shared finalization path.
   *
   *   - undispatched: terminal `cancelled` immediately, hold released (unchanged);
   *   - dispatched/unknown: intent recorded, `status` stays `running`;
   *   - terminal: returned unchanged, so repeats are no-ops.
   *
   * A foreign, missing, or malformed id is still the same non-enumerating 404.
   */
  async cancelRun(actorUserId: string, runId: string): Promise<RunView> {
    const current = await this.runs.loadOwnedRun(actorUserId, runId);

    if (isTerminalRunStatus(current.status)) {
      return toRunView(current);
    }

    const requested =
      (await this.runs.requestCancel(current.id, actorUserId, 'user')) ??
      (await this.runs.loadOwnedRun(actorUserId, runId));

    if (isTerminalRunStatus(requested.status)) {
      return toRunView(requested);
    }

    if (requested.dispatch_state !== 'not_dispatched') {
      // Accepted, not stopped. The owning worker owns the adapter call.
      return toRunView(requested);
    }

    // Provably never reached the provider. The dispatch-state guard makes this
    // atomic against a worker claim: if it won, this update matches nothing and
    // the intent above is what the worker will honour.
    const cancelled = await this.runs.terminalize({
      runId: requested.id,
      ownerUserId: actorUserId,
      status: 'cancelled',
      dispatchState: null,
      errorCode: null,
      usage: unknownUsage(),
      lastEventSeq: 0,
      startExecution: false,
      expectedDispatchState: 'not_dispatched',
    });

    if (cancelled === null) {
      return toRunView(await this.runs.loadOwnedRun(actorUserId, runId));
    }

    // The Run provably never reached the provider, so its allowance hold is
    // released rather than settled. Cancellation stays terminal even if the
    // release is unavailable.
    const reservation = await this.runs
      .findReservation(cancelled.id, actorUserId)
      .catch(() => null);

    if (reservation?.state === 'reserved') {
      await this.releaseQuietly(reservation.id, actorUserId);
    }

    return toRunView(cancelled);
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
