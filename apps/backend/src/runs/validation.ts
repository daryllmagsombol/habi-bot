/**
 * Run-controller validation and request fingerprinting.
 *
 * Validation happens before any reservation so a malformed submit creates no
 * row and no dispatch. The fingerprint is deterministic over the fields that
 * make a submit meaningfully different: conversation, Bot, and ordered context.
 * Server-derived fields (deadline default, now, run id) are excluded so a retry
 * of the same submit is not reported as a conflict.
 */
import { createHash } from 'node:crypto';
import type { CancelReason } from '../adapters/harness-adapter.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import type { RunMessageInput, RunTokenBudget } from './types.js';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;
export const RUN_MESSAGE_MAX_COUNT = 200;
export const RUN_MESSAGE_MAX_LENGTH = 100_000;
export const RUN_MESSAGE_ID_MAX_LENGTH = 200;
export const DEFAULT_MAX_INPUT_TOKENS = 64_000;
export const DEFAULT_MAX_OUTPUT_TOKENS: number | null = null;
export const DEFAULT_DEADLINE_MS = 120_000;

const TOKEN_LIMIT_MAX = 10_000_000;
const MESSAGE_ROLES: ReadonlySet<string> = new Set([
  'user',
  'assistant',
  'system',
]);
const CANCEL_REASONS: ReadonlySet<string> = new Set([
  'user',
  'deadline',
  'shutdown',
  'policy',
]);

/** C0/C1 controls except tab and line feed; same rule as stored Bot text. */
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

function characterLength(value: string): number {
  return Array.from(value).length;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

function invalid(): never {
  throw new PersistenceValidationError('invalid_input');
}

export function normalizeIdempotencyKey(value: unknown): string {
  const key = requireString(value).trim();
  const length = characterLength(key);

  if (
    length === 0 ||
    length > IDEMPOTENCY_KEY_MAX_LENGTH ||
    hasForbiddenControlCharacters(key)
  ) {
    invalid();
  }

  return key;
}

/**
 * Validates Habi-selected context. The controller never re-selects memory; it
 * passes exactly what the caller supplied, in order.
 */
export function normalizeMessages(
  value: readonly RunMessageInput[] | undefined,
): RunMessageInput[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > RUN_MESSAGE_MAX_COUNT) {
    invalid();
  }

  return value.map((message) => {
    if (typeof message !== 'object' || message === null || !MESSAGE_ROLES.has(message.role)) {
      invalid();
    }

    const content = requireString(message.content);
    const messageId = requireString(message.messageId).trim();

    if (
      characterLength(content) === 0 ||
      characterLength(content) > RUN_MESSAGE_MAX_LENGTH ||
      hasForbiddenControlCharacters(content) ||
      characterLength(messageId) === 0 ||
      characterLength(messageId) > RUN_MESSAGE_ID_MAX_LENGTH ||
      hasForbiddenControlCharacters(messageId)
    ) {
      invalid();
    }

    return {
      role: message.role,
      content,
      messageId,
    };
  });
}

export function normalizeCancelReason(value: unknown): CancelReason {
  if (typeof value !== 'string' || !CANCEL_REASONS.has(value)) {
    invalid();
  }

  return value as CancelReason;
}

export function normalizeDeadlineAt(value: unknown, now: number): string {
  if (value === undefined) {
    return new Date(now + DEFAULT_DEADLINE_MS).toISOString();
  }

  const deadline = requireString(value);
  const timestamp = Date.parse(deadline);

  if (Number.isNaN(timestamp)) {
    invalid();
  }

  return new Date(timestamp).toISOString();
}

function normalizeTokenLimit(value: unknown, nullable: boolean): number | null {
  if (value === null && nullable) {
    return null;
  }

  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > TOKEN_LIMIT_MAX
  ) {
    invalid();
  }

  return value;
}

export function normalizeTokenBudget(value: unknown): RunTokenBudget {
  if (value === undefined) {
    return {
      maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    };
  }

  if (typeof value !== 'object' || value === null) {
    invalid();
  }

  const budget = value as { maxInputTokens?: unknown; maxOutputTokens?: unknown };
  const maxInputTokens = normalizeTokenLimit(budget.maxInputTokens, false);

  if (maxInputTokens === null) {
    invalid();
  }

  return {
    maxInputTokens,
    maxOutputTokens: normalizeTokenLimit(budget.maxOutputTokens, true),
  };
}

/**
 * The POC has no tool capability. Rejecting a non-empty list before dispatch
 * keeps the no-tool boundary at the controller as well as the adapter.
 */
export function normalizeAllowedTools(value: readonly string[] | undefined): [] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    invalid();
  }

  if (value.length > 0) {
    invalid();
  }

  return [];
}

/**
 * Deterministic fingerprint for duplicate-submission detection. Only
 * caller-meaningful fields are included; key order is fixed by construction.
 */
export function fingerprintRunRequest(input: {
  conversationId: string;
  botId: string;
  messages: readonly RunMessageInput[];
}): string {
  const canonical = JSON.stringify([
    'run-request:v1',
    input.conversationId,
    input.botId,
    input.messages.map((message) => [
      message.messageId,
      message.role,
      message.content,
    ]),
  ]);

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
