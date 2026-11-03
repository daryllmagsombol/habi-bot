/**
 * H-031 input normalization. Every value here is untrusted caller input except
 * the actor id, which comes from the session boundary. Malformed resource ids
 * fail closed with the same not-found the ownership layer uses, so a bad shape
 * does not become a distinguishable server error.
 */
import { isUuid } from '../persistence/cursor.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import { normalizeLimit } from '../persistence/pagination.js';
import { requireResourceId } from '../persistence/rows.js';
import { decodeSkillCursor } from './cursor.js';
import type {
  CreatableSkillStatus,
  CreateSkillInput,
  CreateSkillRecord,
  ListSkillVersionsOptions,
  ListSkillsOptions,
  NormalizedListSkillsOptions,
  NormalizedListSkillVersionsOptions,
  SkillStatus,
  UpdateSkillInput,
  UpdateSkillRecord,
} from './types.js';

/** H-031 field bounds. Validation rules, not a per-user skill quota. */
export const SKILL_NAME_MIN_LENGTH = 1;
export const SKILL_NAME_MAX_LENGTH = 80;
export const SKILL_DESCRIPTION_MAX_LENGTH = 500;
/** 64 KiB measured as UTF-8 bytes, matching migration 0014's `octet_length`. */
export const SKILL_BODY_MAX_BYTES = 65_536;
export const DEFAULT_SKILL_PAGE_SIZE = 20;

const SKILL_STATUSES: ReadonlySet<string> = new Set<SkillStatus>([
  'draft',
  'active',
  'archived',
  'deleted',
]);

const CREATE_SKILL_STATUSES: ReadonlySet<string> = new Set<CreatableSkillStatus>([
  'draft',
  'active',
]);

/**
 * C0/C1 controls except tab (`\u0009`) and line feed (`\u000a`). Carriage
 * returns are rejected so stored Markdown has one newline convention; clients
 * sending CRLF should normalize before storing.
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

/** UTF-8 byte length, matching PostgreSQL `octet_length` on a UTF-8 database. */
function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** Trims and validates a skill name: 1-80 code points, no C0/C1 controls. */
export function normalizeSkillName(value: unknown): string {
  const name = requireString(value).trim();
  const length = characterLength(name);

  if (
    length < SKILL_NAME_MIN_LENGTH ||
    length > SKILL_NAME_MAX_LENGTH ||
    hasForbiddenControlCharacters(name)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return name;
}

/** Validates free-form description text; empty is the safe default. */
export function normalizeSkillDescription(value: unknown): string {
  const description = requireString(value);

  if (
    characterLength(description) > SKILL_DESCRIPTION_MAX_LENGTH ||
    hasForbiddenControlCharacters(description)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return description;
}

/**
 * Validates untrusted Markdown. It is stored verbatim, never transformed:
 * sanitization here is limited to control-character rejection and a 64 KiB
 * byte bound. Markdown/HTML in the body is inert data; execution and rendering
 * boundaries live outside this module.
 */
export function normalizeSkillBody(value: unknown): string {
  const bodyMarkdown = requireString(value);

  if (
    byteLength(bodyMarkdown) > SKILL_BODY_MAX_BYTES ||
    hasForbiddenControlCharacters(bodyMarkdown)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return bodyMarkdown;
}

function normalizeCreateStatus(value: unknown): CreatableSkillStatus {
  if (value === undefined) {
    return 'draft';
  }

  if (typeof value !== 'string' || !CREATE_SKILL_STATUSES.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as CreatableSkillStatus;
}

/** Normalizes a creation payload. Name is required; the rest has safe defaults. */
export function normalizeCreateSkillInput(
  input: CreateSkillInput,
): CreateSkillRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    name: normalizeSkillName(input.name),
    description:
      input.description === undefined
        ? ''
        : normalizeSkillDescription(input.description),
    bodyMarkdown:
      input.bodyMarkdown === undefined
        ? ''
        : normalizeSkillBody(input.bodyMarkdown),
    botId:
      input.botId === undefined || input.botId === null
        ? null
        : requireResourceId(input.botId),
    status: normalizeCreateStatus(input.status),
  };
}

/**
 * Normalizes a patch. `undefined` leaves a field unchanged; `null` clears
 * description or body to `''`. An empty patch is rejected so a no-op cannot
 * silently create a version.
 */
export function normalizeUpdateSkillInput(
  input: UpdateSkillInput,
): UpdateSkillRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  const patch: UpdateSkillRecord = {};

  if (input.name !== undefined) {
    patch.name = normalizeSkillName(input.name);
  }
  if (input.description !== undefined) {
    patch.description =
      input.description === null
        ? ''
        : normalizeSkillDescription(input.description);
  }
  if (input.bodyMarkdown !== undefined) {
    patch.bodyMarkdown =
      input.bodyMarkdown === null ? '' : normalizeSkillBody(input.bodyMarkdown);
  }

  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.bodyMarkdown === undefined
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return patch;
}

function normalizeStatus(value: unknown): SkillStatus {
  if (typeof value !== 'string' || !SKILL_STATUSES.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as SkillStatus;
}

/** A list filter is input, not an access key; a bad shape is invalid input. */
function normalizeBotFilter(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (!isUuid(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** Normalizes owner-scoped listing filters. Tombstones only list on request. */
export function normalizeListSkillsOptions(
  options: ListSkillsOptions = {},
): NormalizedListSkillsOptions {
  return {
    status:
      options.status === undefined ? null : normalizeStatus(options.status),
    botId: normalizeBotFilter(options.botId),
    limit:
      options.limit === undefined
        ? DEFAULT_SKILL_PAGE_SIZE
        : normalizeLimit(options.limit),
    cursor:
      options.cursor === undefined ? null : decodeSkillCursor(options.cursor),
  };
}

/** Version numbers are positive integers; anything else is malformed input. */
export function normalizeSkillVersionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** Normalizes a version-history page request. */
export function normalizeListSkillVersionsOptions(
  options: ListSkillVersionsOptions = {},
): NormalizedListSkillVersionsOptions {
  return {
    limit:
      options.limit === undefined
        ? DEFAULT_SKILL_PAGE_SIZE
        : normalizeLimit(options.limit),
    beforeVersion:
      options.beforeVersion === undefined
        ? null
        : normalizeSkillVersionNumber(options.beforeVersion),
  };
}
