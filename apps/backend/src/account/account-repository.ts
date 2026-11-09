/**
 * H-032 (#32) owner-scoped reads for export and rows removed by account
 * deletion.
 *
 * Every statement binds the session actor to `owner_user_id` (or `user_id` for
 * the identity tables) itself. There is no statement that resolves an account
 * from a request body, path, or query value, and no statement that can read or
 * remove another account's row.
 *
 * Export is server-assembled in bounded keyset pages. The service holds one
 * repeatable-read transaction so the manifest counts and the streamed rows
 * describe the same snapshot.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import type { Queryable } from '../persistence/database.js';
import {
  toIso,
  toNullableIso,
  type NullableTimestamp,
  type Timestamp,
} from '../persistence/rows.js';

/** Rows per export page. One page is the largest amount buffered at a time. */
export const EXPORT_BATCH_SIZE = 200;

export type ExportSectionKey =
  | 'ssoIdentities'
  | 'bots'
  | 'conversations'
  | 'messages'
  | 'runs'
  | 'runEvents'
  | 'artifacts'
  | 'artifactVersions'
  | 'attachments'
  | 'attachmentText'
  | 'memories'
  | 'memoryAudit'
  | 'skills'
  | 'skillVersions'
  | 'usageBuckets'
  | 'usageReservations'
  | 'usageAudit'
  | 'search';

export type ExportCounts = Record<ExportSectionKey, number>;

export type RemovedCounts = {
  attachments: number;
  attachmentText: number;
  memories: number;
  memoryAudit: number;
  artifacts: number;
  artifactVersions: number;
  messages: number;
  skills: number;
  skillVersions: number;
  runs: number;
  runEvents: number;
  conversations: number;
  bots: number;
  usageBuckets: number;
  usageReservations: number;
  usageAudit: number;
  ssoIdentities: number;
  ssoPending: number;
  passwordResetTokens: number;
};

export interface AccountDeletionState {
  email: string | null;
  status: string;
  deletedAt: string | null;
}

export interface AccountProfileExport {
  userId: string;
  email: string | null;
  status: string;
  emailVerifiedAt: string | null;
  recoveryEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachmentLocator {
  attachmentId: string;
  conversationId: string;
}

interface AccountRow {
  id: string;
  email: string | null;
  status: string;
  deleted_at: NullableTimestamp;
}

interface ProfileRow {
  id: string;
  email: string | null;
  status: string;
  email_verified_at: NullableTimestamp;
  recovery_email: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface SsoIdentityRow {
  id: string;
  provider: string;
  subject: string;
  email: string | null;
  email_trusted: boolean;
  created_at: Timestamp;
  last_login_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
}

interface BotRow {
  id: string;
  name: string;
  description: string;
  avatar_ref: string | null;
  instructions_markdown: string;
  status: string;
  archived_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface ConversationExportRow {
  id: string;
  bot_id: string;
  title: string;
  status: string;
  last_message_seq: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface MessageExportRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  seq: string;
  status: string;
  client_message_id: string | null;
  run_id: string | null;
  created_at: Timestamp;
  finalized_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

interface RunExportRow {
  id: string;
  conversation_id: string;
  status: string;
  dispatch_state: string;
  harness_run_id: string | null;
  harness_session_id: string | null;
  error_code: string | null;
  usage_status: string;
  usage_gross_prompt_tokens: string | null;
  usage_gross_completion_tokens: string | null;
  usage_cached_prompt_tokens: string | null;
  usage_reasoning_tokens: string | null;
  usage_total_tokens: string | null;
  usage_cost_status: string;
  usage_raw: unknown;
  last_event_seq: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  started_at: NullableTimestamp;
  finished_at: NullableTimestamp;
  cancel_requested_at: NullableTimestamp;
  cancel_reason: string | null;
  cancel_claimed_at: NullableTimestamp;
  cancel_attempts: number;
  cancel_error_code: string | null;
}

interface RunEventExportRow {
  id: string;
  run_id: string;
  conversation_id: string;
  seq: string;
  type: string;
  payload: unknown;
  created_at: Timestamp;
}

interface ArtifactExportRow {
  id: string;
  conversation_id: string | null;
  run_id: string | null;
  kind: string;
  title: string;
  current_version: number;
  status: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface ArtifactVersionRow {
  artifact_id: string;
  version: number;
  content: string;
  content_sha256: string;
  byte_size: number;
  created_by: string;
  created_at: Timestamp;
}

interface AttachmentExportRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  original_filename: string;
  content_type: string;
  byte_size: string | number;
  sha256: string;
  status: string;
  created_at: Timestamp;
  stored_at: NullableTimestamp;
  deleted_at: NullableTimestamp;
}

interface DocumentChunkRow {
  id: string;
  attachment_id: string;
  conversation_id: string;
  chunk_index: number;
  text: string;
  start_offset: number;
  end_offset: number;
  created_at: Timestamp;
}

interface MemoryExportRow {
  id: string;
  bot_id: string;
  conversation_id: string | null;
  content: string;
  source_message_id: string | null;
  status: string;
  bot_approved: boolean;
  conversation_approved: boolean;
  provenance_state: string;
  provenance_tombstoned_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface MemoryAuditRow {
  id: string;
  memory_id: string;
  action: string;
  actor_user_id: string;
  note: string;
  created_at: Timestamp;
}

interface SkillRow {
  id: string;
  bot_id: string | null;
  name: string;
  description: string;
  body_markdown: string;
  version: number;
  status: string;
  archived_at: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  deleted_at: NullableTimestamp;
}

interface SkillVersionRow {
  id: string;
  skill_id: string;
  version: number;
  name: string;
  description: string;
  body_markdown: string;
  created_at: Timestamp;
}

interface UsageBucketRow {
  day_bucket: string;
  input_tokens: string;
  output_tokens: string;
  reserved_tokens: string;
  state: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

interface UsageReservationRow {
  id: string;
  run_id: string;
  day_bucket: string;
  estimated_tokens: string;
  charged_tokens: string;
  state: string;
  usage_status: string | null;
  created_at: Timestamp;
  settled_at: NullableTimestamp;
  released_at: NullableTimestamp;
  reconciled_at: NullableTimestamp;
  reconciled_by: string | null;
  reconcile_note: string | null;
}

interface UsageAuditRow {
  id: string;
  day_bucket: string;
  actor_user_id: string;
  action: string;
  tokens_delta: string;
  note: string;
  created_at: Timestamp;
}

interface SearchRow {
  id: string;
  conversation_id: string;
  bot_id: string;
  role: string;
  seq: string;
  content: string;
  created_at: Timestamp;
}

interface CountRow {
  count: number;
}

function toNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toSequence(value: string | number): number {
  return Number(value);
}

function mapProfile(row: ProfileRow): AccountProfileExport {
  return {
    userId: row.id,
    email: row.email,
    status: row.status,
    emailVerifiedAt: toNullableIso(row.email_verified_at),
    recoveryEmail: row.recovery_email,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapSsoIdentity(row: SsoIdentityRow): Record<string, unknown> {
  return {
    id: row.id,
    provider: row.provider,
    subject: row.subject,
    email: row.email,
    emailTrusted: row.email_trusted,
    createdAt: toIso(row.created_at),
    lastLoginAt: toNullableIso(row.last_login_at),
    revokedAt: toNullableIso(row.revoked_at),
  };
}

function mapBot(row: BotRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    avatarRef: row.avatar_ref,
    instructionsMarkdown: row.instructions_markdown,
    status: row.status,
    archivedAt: toNullableIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapConversation(row: ConversationExportRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.bot_id,
    title: row.title,
    status: row.status,
    lastMessageSeq: toSequence(row.last_message_seq),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapMessage(row: MessageExportRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    seq: toSequence(row.seq),
    status: row.status,
    clientMessageId: row.client_message_id,
    runId: row.run_id,
    createdAt: toIso(row.created_at),
    finalizedAt: toNullableIso(row.finalized_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapRun(row: RunExportRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    dispatchState: row.dispatch_state,
    harnessRunId: row.harness_run_id,
    harnessSessionId: row.harness_session_id,
    errorCode: row.error_code,
    usage: {
      status: row.usage_status,
      grossPromptTokens: toNumber(row.usage_gross_prompt_tokens),
      grossCompletionTokens: toNumber(row.usage_gross_completion_tokens),
      cachedPromptTokens: toNumber(row.usage_cached_prompt_tokens),
      reasoningTokens: toNumber(row.usage_reasoning_tokens),
      totalTokens: toNumber(row.usage_total_tokens),
      costStatus: row.usage_cost_status,
      raw: row.usage_raw,
    },
    lastEventSeq: toSequence(row.last_event_seq),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    startedAt: toNullableIso(row.started_at),
    finishedAt: toNullableIso(row.finished_at),
    cancelRequestedAt: toNullableIso(row.cancel_requested_at),
    cancelReason: row.cancel_reason,
    cancelClaimedAt: toNullableIso(row.cancel_claimed_at),
    cancelAttempts: row.cancel_attempts,
    cancelErrorCode: row.cancel_error_code,
  };
}

function mapRunEvent(row: RunEventExportRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    seq: toSequence(row.seq),
    type: row.type,
    payload: row.payload,
    createdAt: toIso(row.created_at),
  };
}

function mapArtifact(row: ArtifactExportRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    kind: row.kind,
    title: row.title,
    currentVersion: row.current_version,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapArtifactVersion(row: ArtifactVersionRow): Record<string, unknown> {
  return {
    artifactId: row.artifact_id,
    version: row.version,
    content: row.content,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

function mapAttachment(row: AttachmentExportRow): Record<string, unknown> {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    status: row.status,
    createdAt: toIso(row.created_at),
    storedAt: toNullableIso(row.stored_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapDocumentChunk(row: DocumentChunkRow): Record<string, unknown> {
  return {
    attachmentId: row.attachment_id,
    conversationId: row.conversation_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    createdAt: toIso(row.created_at),
  };
}

function mapMemory(row: MemoryExportRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.bot_id,
    conversationId: row.conversation_id,
    content: row.content,
    sourceMessageId: row.source_message_id,
    status: row.status,
    botApproved: row.bot_approved,
    conversationApproved: row.conversation_approved,
    provenanceState: row.provenance_state,
    provenanceTombstonedAt: toNullableIso(row.provenance_tombstoned_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapMemoryAudit(row: MemoryAuditRow): Record<string, unknown> {
  return {
    id: row.id,
    memoryId: row.memory_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    note: row.note,
    createdAt: toIso(row.created_at),
  };
}

function mapSkill(row: SkillRow): Record<string, unknown> {
  return {
    id: row.id,
    botId: row.bot_id,
    name: row.name,
    description: row.description,
    bodyMarkdown: row.body_markdown,
    version: row.version,
    status: row.status,
    archivedAt: toNullableIso(row.archived_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toNullableIso(row.deleted_at),
  };
}

function mapSkillVersion(row: SkillVersionRow): Record<string, unknown> {
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    name: row.name,
    description: row.description,
    bodyMarkdown: row.body_markdown,
    createdAt: toIso(row.created_at),
  };
}

function mapUsageBucket(row: UsageBucketRow): Record<string, unknown> {
  return {
    dayBucket: row.day_bucket,
    inputTokens: toSequence(row.input_tokens),
    outputTokens: toSequence(row.output_tokens),
    reservedTokens: toSequence(row.reserved_tokens),
    state: row.state,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapUsageReservation(row: UsageReservationRow): Record<string, unknown> {
  return {
    id: row.id,
    runId: row.run_id,
    dayBucket: row.day_bucket,
    estimatedTokens: toSequence(row.estimated_tokens),
    chargedTokens: toSequence(row.charged_tokens),
    state: row.state,
    usageStatus: row.usage_status,
    createdAt: toIso(row.created_at),
    settledAt: toNullableIso(row.settled_at),
    releasedAt: toNullableIso(row.released_at),
    reconciledAt: toNullableIso(row.reconciled_at),
    reconciledBy: row.reconciled_by,
    reconcileNote: row.reconcile_note,
  };
}

function mapUsageAudit(row: UsageAuditRow): Record<string, unknown> {
  return {
    id: row.id,
    dayBucket: row.day_bucket,
    actorUserId: row.actor_user_id,
    action: row.action,
    tokensDelta: toSequence(row.tokens_delta),
    note: row.note,
    createdAt: toIso(row.created_at),
  };
}

function mapSearch(row: SearchRow): Record<string, unknown> {
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    botId: row.bot_id,
    role: row.role,
    seq: toSequence(row.seq),
    text: row.content,
    createdAt: toIso(row.created_at),
  };
}

const SEARCH_SCOPE = `m.owner_user_id = $1
   AND c.owner_user_id = $1
   AND c.deleted_at IS NULL
   AND c.status <> 'deleted'
   AND b.owner_user_id = $1
   AND b.deleted_at IS NULL
   AND b.status <> 'deleted'
   AND m.deleted_at IS NULL
   AND m.status <> 'deleted'`;

const COUNT_SQL: Readonly<Record<ExportSectionKey, string>> = {
  ssoIdentities: 'SELECT count(*)::int AS count FROM sso_identities WHERE user_id = $1',
  bots: 'SELECT count(*)::int AS count FROM bots WHERE owner_user_id = $1',
  conversations:
    'SELECT count(*)::int AS count FROM conversations WHERE owner_user_id = $1',
  messages: 'SELECT count(*)::int AS count FROM messages WHERE owner_user_id = $1',
  runs: 'SELECT count(*)::int AS count FROM runs WHERE owner_user_id = $1',
  runEvents: 'SELECT count(*)::int AS count FROM run_events WHERE owner_user_id = $1',
  artifacts: 'SELECT count(*)::int AS count FROM artifacts WHERE owner_user_id = $1',
  artifactVersions:
    'SELECT count(*)::int AS count FROM artifact_versions WHERE owner_user_id = $1',
  attachments:
    'SELECT count(*)::int AS count FROM attachments WHERE owner_user_id = $1',
  attachmentText:
    'SELECT count(*)::int AS count FROM document_chunks WHERE owner_user_id = $1',
  memories: 'SELECT count(*)::int AS count FROM memories WHERE owner_user_id = $1',
  memoryAudit:
    'SELECT count(*)::int AS count FROM memory_audit WHERE owner_user_id = $1',
  skills: 'SELECT count(*)::int AS count FROM skills WHERE owner_user_id = $1',
  skillVersions:
    'SELECT count(*)::int AS count FROM skill_versions WHERE owner_user_id = $1',
  usageBuckets:
    'SELECT count(*)::int AS count FROM usage_buckets WHERE owner_user_id = $1',
  usageReservations:
    'SELECT count(*)::int AS count FROM usage_reservations WHERE owner_user_id = $1',
  usageAudit:
    'SELECT count(*)::int AS count FROM usage_limit_audit WHERE owner_user_id = $1',
  search: `SELECT count(*)::int AS count
     FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     JOIN bots b ON b.id = c.bot_id
    WHERE ${SEARCH_SCOPE}`,
};

const BY_ID_PAGE = (select: string, from: string): string =>
  `SELECT ${select}
     FROM ${from}
    WHERE owner_user_id = $1
      AND ($2::uuid IS NULL OR id > $2::uuid)
    ORDER BY id
    LIMIT $3`;

const BY_ID_SQL: Readonly<
  Partial<Record<ExportSectionKey, string>>
> = {
  ssoIdentities: `SELECT id, provider, subject, email, email_trusted, created_at,
       last_login_at, revoked_at
     FROM sso_identities
    WHERE user_id = $1
      AND ($2::uuid IS NULL OR id > $2::uuid)
    ORDER BY id
    LIMIT $3`,
  bots: BY_ID_PAGE(
    'id, name, description, avatar_ref, instructions_markdown, status, archived_at, created_at, updated_at, deleted_at',
    'bots',
  ),
  conversations: BY_ID_PAGE(
    'id, bot_id, title, status, last_message_seq, created_at, updated_at, deleted_at',
    'conversations',
  ),
  messages: BY_ID_PAGE(
    'id, conversation_id, role, content, seq, status, client_message_id, run_id, created_at, finalized_at, deleted_at',
    'messages',
  ),
  runs: BY_ID_PAGE(
    `id, conversation_id, status, dispatch_state, harness_run_id,
     harness_session_id, error_code, usage_status, usage_gross_prompt_tokens,
     usage_gross_completion_tokens, usage_cached_prompt_tokens,
     usage_reasoning_tokens, usage_total_tokens, usage_cost_status, usage_raw,
     last_event_seq, created_at, updated_at, started_at, finished_at,
     cancel_requested_at, cancel_reason, cancel_claimed_at, cancel_attempts,
     cancel_error_code`,
    'runs',
  ),
  runEvents: BY_ID_PAGE(
    'id, run_id, conversation_id, seq, type, payload, created_at',
    'run_events',
  ),
  artifacts: BY_ID_PAGE(
    'id, conversation_id, run_id, kind, title, current_version, status, created_at, updated_at, deleted_at',
    'artifacts',
  ),
  attachments: BY_ID_PAGE(
    'id, conversation_id, message_id, original_filename, content_type, byte_size, sha256, status, created_at, stored_at, deleted_at',
    'attachments',
  ),
  attachmentText: BY_ID_PAGE(
    'id, attachment_id, conversation_id, chunk_index, text, start_offset, end_offset, created_at',
    'document_chunks',
  ),
  memories: BY_ID_PAGE(
    `id, bot_id, conversation_id, content, source_message_id, status,
     bot_approved, conversation_approved, provenance_state,
     provenance_tombstoned_at, created_at, updated_at, deleted_at`,
    'memories',
  ),
  memoryAudit: BY_ID_PAGE(
    'id, memory_id, action, actor_user_id, note, created_at',
    'memory_audit',
  ),
  skills: BY_ID_PAGE(
    `id, bot_id, name, description, body_markdown, version, status, archived_at,
     created_at, updated_at, deleted_at`,
    'skills',
  ),
  skillVersions: BY_ID_PAGE(
    'id, skill_id, version, name, description, body_markdown, created_at',
    'skill_versions',
  ),
  usageReservations: BY_ID_PAGE(
    `id, run_id, day_bucket::text AS day_bucket, estimated_tokens,
     charged_tokens, state, usage_status, created_at, settled_at, released_at,
     reconciled_at, reconciled_by, reconcile_note`,
    'usage_reservations',
  ),
  usageAudit: BY_ID_PAGE(
    'id, day_bucket::text AS day_bucket, actor_user_id, action, tokens_delta, note, created_at',
    'usage_limit_audit',
  ),
};

export class AccountRepository {
  async lockAccount(
    client: Queryable,
    ownerUserId: string,
  ): Promise<AccountDeletionState | null> {
    const result = await client.query<AccountRow>(
      `SELECT id, email, status, deleted_at
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [ownerUserId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      return null;
    }

    return {
      email: row.email,
      status: row.status,
      deletedAt: toNullableIso(row.deleted_at),
    };
  }

  async loadExportProfile(
    client: Queryable,
    ownerUserId: string,
  ): Promise<AccountProfileExport | null> {
    const result = await client.query<ProfileRow>(
      `SELECT id, email, status, email_verified_at, recovery_email,
              created_at, updated_at
         FROM users
        WHERE id = $1
          AND status = 'active'
          AND deleted_at IS NULL`,
      [ownerUserId],
    );
    const row = result.rows[0];

    return row === undefined ? null : mapProfile(row);
  }

  async attachmentLocators(
    client: Queryable,
    ownerUserId: string,
  ): Promise<AttachmentLocator[]> {
    const result = await client.query<{ id: string; conversation_id: string }>(
      `SELECT id, conversation_id
         FROM attachments
        WHERE owner_user_id = $1`,
      [ownerUserId],
    );

    return result.rows.map((row) => ({
      attachmentId: row.id,
      conversationId: row.conversation_id,
    }));
  }

  async countExport(
    client: Queryable,
    ownerUserId: string,
  ): Promise<ExportCounts> {
    const counts = {} as ExportCounts;

    for (const key of Object.keys(COUNT_SQL) as ExportSectionKey[]) {
      const result = await client.query<CountRow>(COUNT_SQL[key], [ownerUserId]);
      counts[key] = result.rows[0]?.count ?? 0;
    }

    return counts;
  }

  async *streamSection(
    client: Queryable,
    ownerUserId: string,
    key: ExportSectionKey,
  ): AsyncGenerator<Record<string, unknown>> {
    if (key === 'artifactVersions') {
      yield* this.streamArtifactVersions(client, ownerUserId);
      return;
    }

    if (key === 'usageBuckets') {
      yield* this.streamUsageBuckets(client, ownerUserId);
      return;
    }

    if (key === 'search') {
      yield* this.streamSearch(client, ownerUserId);
      return;
    }

    const sql = BY_ID_SQL[key];

    if (sql === undefined) {
      throw new Error(`No export query is defined for section ${key}.`);
    }

    yield* this.streamById(client, ownerUserId, sql, key);
  }

  private async *streamById(
    client: Queryable,
    ownerUserId: string,
    sql: string,
    key: ExportSectionKey,
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | null = null;

    for (;;) {
      const result: QueryResult<QueryResultRow & { id: string }> = await client.query<
        QueryResultRow & { id: string }
      >(sql, [
        ownerUserId,
        cursor,
        EXPORT_BATCH_SIZE,
      ]);

      for (const row of result.rows) {
        yield this.mapByKey(key, row);
      }

      if (result.rows.length < EXPORT_BATCH_SIZE) {
        return;
      }

      const last = result.rows[result.rows.length - 1];

      if (last === undefined) {
        return;
      }

      cursor = last.id;
    }
  }

  private async *streamArtifactVersions(
    client: Queryable,
    ownerUserId: string,
  ): AsyncGenerator<Record<string, unknown>> {
    let cursorArtifactId: string | null = null;
    let cursorVersion: number | null = null;

    for (;;) {
      const result: QueryResult<ArtifactVersionRow> = await client.query<ArtifactVersionRow>(
        `SELECT artifact_id, version, content, content_sha256, byte_size,
                created_by, created_at
           FROM artifact_versions
          WHERE owner_user_id = $1
            AND (
              $2::uuid IS NULL
              OR (artifact_id, version) > ($2::uuid, $3::integer)
            )
          ORDER BY artifact_id, version
          LIMIT $4`,
        [ownerUserId, cursorArtifactId, cursorVersion, EXPORT_BATCH_SIZE],
      );

      for (const row of result.rows) {
        yield mapArtifactVersion(row);
      }

      if (result.rows.length < EXPORT_BATCH_SIZE) {
        return;
      }

      const last = result.rows[result.rows.length - 1];

      if (last === undefined) {
        return;
      }

      cursorArtifactId = last.artifact_id;
      cursorVersion = last.version;
    }
  }

  private async *streamUsageBuckets(
    client: Queryable,
    ownerUserId: string,
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | null = null;

    for (;;) {
      const result: QueryResult<UsageBucketRow> = await client.query<UsageBucketRow>(
        `SELECT day_bucket::text AS day_bucket, input_tokens, output_tokens,
                reserved_tokens, state, created_at, updated_at
           FROM usage_buckets
          WHERE owner_user_id = $1
            AND ($2::date IS NULL OR day_bucket > $2::date)
          ORDER BY day_bucket
          LIMIT $3`,
        [ownerUserId, cursor, EXPORT_BATCH_SIZE],
      );

      for (const row of result.rows) {
        yield mapUsageBucket(row);
      }

      if (result.rows.length < EXPORT_BATCH_SIZE) {
        return;
      }

      const last = result.rows[result.rows.length - 1];

      if (last === undefined) {
        return;
      }

      cursor = last.day_bucket;
    }
  }

  private async *streamSearch(
    client: Queryable,
    ownerUserId: string,
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | null = null;

    for (;;) {
      const result: QueryResult<SearchRow> = await client.query<SearchRow>(
        `SELECT m.id,
                m.conversation_id,
                c.bot_id,
                m.role,
                m.seq,
                m.content,
                m.created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN bots b ON b.id = c.bot_id
          WHERE ${SEARCH_SCOPE}
            AND ($2::uuid IS NULL OR m.id > $2::uuid)
          ORDER BY m.id
          LIMIT $3`,
        [ownerUserId, cursor, EXPORT_BATCH_SIZE],
      );

      for (const row of result.rows) {
        yield mapSearch(row);
      }

      if (result.rows.length < EXPORT_BATCH_SIZE) {
        return;
      }

      const last = result.rows[result.rows.length - 1];

      if (last === undefined) {
        return;
      }

      cursor = last.id;
    }
  }

  private mapByKey(
    key: ExportSectionKey,
    row: QueryResultRow,
  ): Record<string, unknown> {
    switch (key) {
      case 'ssoIdentities':
        return mapSsoIdentity(row as unknown as SsoIdentityRow);
      case 'bots':
        return mapBot(row as unknown as BotRow);
      case 'conversations':
        return mapConversation(row as unknown as ConversationExportRow);
      case 'messages':
        return mapMessage(row as unknown as MessageExportRow);
      case 'runs':
        return mapRun(row as unknown as RunExportRow);
      case 'runEvents':
        return mapRunEvent(row as unknown as RunEventExportRow);
      case 'artifacts':
        return mapArtifact(row as unknown as ArtifactExportRow);
      case 'attachments':
        return mapAttachment(row as unknown as AttachmentExportRow);
      case 'attachmentText':
        return mapDocumentChunk(row as unknown as DocumentChunkRow);
      case 'memories':
        return mapMemory(row as unknown as MemoryExportRow);
      case 'memoryAudit':
        return mapMemoryAudit(row as unknown as MemoryAuditRow);
      case 'skills':
        return mapSkill(row as unknown as SkillRow);
      case 'skillVersions':
        return mapSkillVersion(row as unknown as SkillVersionRow);
      case 'usageReservations':
        return mapUsageReservation(row as unknown as UsageReservationRow);
      case 'usageAudit':
        return mapUsageAudit(row as unknown as UsageAuditRow);
      default:
        throw new Error(`No export mapping is defined for section ${key}.`);
    }
  }

  /**
   * Removes every owner-scoped row. The order follows the foreign keys:
   * children before parents, Run events through their cascade, and immutable
   * version history under the transaction-local purge guard. No statement can
   * match another owner's row.
   */
  async deleteOwnedRows(
    client: Queryable,
    ownerUserId: string,
  ): Promise<RemovedCounts> {
    await client.query(`SELECT set_config('habi.account_purge', 'on', true)`);
    await client.query(`SET CONSTRAINTS ALL DEFERRED`);

    const runEvents = await client.query<CountRow>(
      'SELECT count(*)::int AS count FROM run_events WHERE owner_user_id = $1',
      [ownerUserId],
    );

    const removed: RemovedCounts = {
      attachments: 0,
      attachmentText: 0,
      memories: 0,
      memoryAudit: 0,
      artifacts: 0,
      artifactVersions: 0,
      messages: 0,
      skills: 0,
      skillVersions: 0,
      runs: 0,
      runEvents: runEvents.rows[0]?.count ?? 0,
      conversations: 0,
      bots: 0,
      usageBuckets: 0,
      usageReservations: 0,
      usageAudit: 0,
      ssoIdentities: 0,
      ssoPending: 0,
      passwordResetTokens: 0,
    };

    const ownedDelete = async (
      table: string,
      column: 'owner_user_id' | 'user_id',
    ): Promise<number> => {
      const result = await client.query(
        `DELETE FROM ${table} WHERE ${column} = $1`,
        [ownerUserId],
      );

      return result.rowCount ?? 0;
    };

    removed.attachmentText = await ownedDelete('document_chunks', 'owner_user_id');
    removed.attachments = await ownedDelete('attachments', 'owner_user_id');
    removed.memoryAudit = await ownedDelete('memory_audit', 'owner_user_id');
    removed.memories = await ownedDelete('memories', 'owner_user_id');
    removed.artifactVersions = await ownedDelete(
      'artifact_versions',
      'owner_user_id',
    );
    removed.artifacts = await ownedDelete('artifacts', 'owner_user_id');
    removed.messages = await ownedDelete('messages', 'owner_user_id');
    removed.skillVersions = await ownedDelete('skill_versions', 'owner_user_id');
    removed.skills = await ownedDelete('skills', 'owner_user_id');
    // `runs` owns `run_events`; the cascade is the only permitted event delete.
    removed.runs = await ownedDelete('runs', 'owner_user_id');
    removed.conversations = await ownedDelete('conversations', 'owner_user_id');
    removed.bots = await ownedDelete('bots', 'owner_user_id');
    removed.usageReservations = await ownedDelete(
      'usage_reservations',
      'owner_user_id',
    );
    removed.usageBuckets = await ownedDelete('usage_buckets', 'owner_user_id');
    removed.usageAudit = await ownedDelete('usage_limit_audit', 'owner_user_id');
    removed.ssoPending = await ownedDelete(
      'sso_pending_authorizations',
      'user_id',
    );
    removed.ssoIdentities = await ownedDelete('sso_identities', 'user_id');
    removed.passwordResetTokens = await ownedDelete(
      'password_reset_tokens',
      'user_id',
    );

    return removed;
  }

  /**
   * Tombstones the identity row and clears credential material. Returns the
   * first deletion time; a repeat keeps it so retries report the same instant.
   */
  async tombstoneAccount(
    client: Queryable,
    ownerUserId: string,
    state: AccountDeletionState,
  ): Promise<string> {
    if (state.deletedAt !== null) {
      return state.deletedAt;
    }

    const result = await client.query<{ deleted_at: Timestamp }>(
      `UPDATE users
          SET status = 'deleted',
              deleted_at = now(),
              updated_at = now(),
              email = NULL,
              password_hash = NULL,
              recovery_email = NULL,
              email_verified_at = NULL
        WHERE id = $1
          AND status <> 'deleted'
        RETURNING deleted_at`,
      [ownerUserId],
    );
    const row = result.rows[0];

    if (row === undefined) {
      // A concurrent deletion won the lock; report its instant.
      const current = await client.query<AccountRow>(
        'SELECT deleted_at FROM users WHERE id = $1',
        [ownerUserId],
      );
      const deletedAt = current.rows[0]?.deleted_at;

      if (deletedAt === null || deletedAt === undefined) {
        throw new Error('Account tombstone disappeared during deletion.');
      }

      return toIso(deletedAt);
    }

    return toIso(row.deleted_at);
  }
}

export const EXPORT_SECTION_KEYS: readonly ExportSectionKey[] = [
  'ssoIdentities',
  'bots',
  'conversations',
  'messages',
  'runs',
  'runEvents',
  'artifacts',
  'artifactVersions',
  'attachments',
  'attachmentText',
  'memories',
  'memoryAudit',
  'skills',
  'skillVersions',
  'usageBuckets',
  'usageReservations',
  'usageAudit',
  'search',
];
