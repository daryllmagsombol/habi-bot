/**
 * H-030 input normalization. Every value here is untrusted caller input except
 * the actor id, which comes from the session boundary. Malformed ids fail
 * closed with the same not-found the ownership layer uses, so a bad shape does
 * not become a distinguishable server error.
 */
import { PersistenceValidationError } from '../persistence/errors.js';
import { requireResourceId } from '../persistence/rows.js';
import { normalizeLimit } from '../persistence/pagination.js';
import type {
  ListMemoriesOptions,
  MemoryStatus,
  ProposeMemoryInput,
  ProposeMemoryRecord,
  RecallMemoriesOptions,
  SourceDeletedInput,
} from './types.js';

export const MEMORY_CONTENT_MIN_LENGTH = 1;
export const MEMORY_CONTENT_MAX_LENGTH = 4_000;
export const DEFAULT_MEMORY_PAGE_SIZE = 50;

const MAX_MEMORY_OFFSET = Number.MAX_SAFE_INTEGER;
const MEMORY_STATUSES: ReadonlySet<string> = new Set<MemoryStatus>([
  'proposed',
  'accepted',
  'deleted',
]);

/**
 * C0/C1 controls except tab (`\u0009`) and line feed (`\u000a`). Carriage
 * returns are rejected so stored text has one newline convention.
 */
function hasForbiddenControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      codePoint === 0x0d ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    ) {
      return true;
    }
  }

  return false;
}

/** Counts Unicode code points, matching PostgreSQL `char_length` on UTF-8. */
function characterLength(value: string): number {
  return Array.from(value).length;
}

/** Trims and validates an accepted-fact text: 1-4,000 code points. */
export function normalizeMemoryContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  const content = value.trim();
  const length = characterLength(content);

  if (
    length < MEMORY_CONTENT_MIN_LENGTH ||
    length > MEMORY_CONTENT_MAX_LENGTH ||
    hasForbiddenControlCharacters(content)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return content;
}

/** Normalizes a proposal. The source conversation and Bot are required. */
export function normalizeProposeMemoryInput(
  input: ProposeMemoryInput,
): ProposeMemoryRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    botId: requireResourceId(input.botId),
    conversationId: requireResourceId(input.conversationId),
    sourceMessageId:
      input.sourceMessageId === undefined || input.sourceMessageId === null
        ? null
        : requireResourceId(input.sourceMessageId),
    content: normalizeMemoryContent(input.content),
  };
}

/** Recall is always one owned conversation under one Bot. */
export function normalizeRecallMemoriesOptions(
  input: RecallMemoriesOptions,
): { botId: string; conversationId: string; limit: number } {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    botId: requireResourceId(input.botId),
    conversationId: requireResourceId(input.conversationId),
    limit: normalizeLimit(input.limit),
  };
}

function normalizeStatus(value: unknown): MemoryStatus {
  if (typeof value !== 'string' || !MEMORY_STATUSES.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as MemoryStatus;
}

function normalizeOffset(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_MEMORY_OFFSET
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

export interface NormalizedListMemoriesOptions {
  botId: string | null;
  conversationId: string | null;
  status: MemoryStatus | null;
  limit: number;
  offset: number;
}

/** Normalizes owner-scoped listing filters. Deleted rows only list on request. */
export function normalizeListMemoriesOptions(
  options: ListMemoriesOptions = {},
): NormalizedListMemoriesOptions {
  return {
    botId:
      options.botId === undefined ? null : requireResourceId(options.botId),
    conversationId:
      options.conversationId === undefined
        ? null
        : requireResourceId(options.conversationId),
    status:
      options.status === undefined ? null : normalizeStatus(options.status),
    limit:
      options.limit === undefined
        ? DEFAULT_MEMORY_PAGE_SIZE
        : normalizeLimit(options.limit),
    offset: normalizeOffset(options.offset),
  };
}

/** D3 source identifiers. Message-level deletion is optional. */
export function normalizeSourceDeletedInput(input: SourceDeletedInput): {
  conversationId: string;
  sourceMessageId: string | null;
} {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    conversationId: requireResourceId(input.conversationId),
    sourceMessageId:
      input.sourceMessageId === undefined || input.sourceMessageId === null
        ? null
        : requireResourceId(input.sourceMessageId),
  };
}

/** Approvals are explicit booleans; a missing argument means the off default. */
export function normalizeApprovalFlag(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}
