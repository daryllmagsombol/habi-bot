/**
 * H-028 input normalization and content integrity helpers.
 *
 * Everything here is untrusted caller input except the actor id, which comes
 * from the session boundary. Malformed ids fail closed with the same not-found
 * the ownership layer uses; malformed content, titles, kinds, statuses, and
 * version numbers fail as `invalid_input`.
 *
 * Content rules:
 *   - it must be a real string that survives a strict UTF-8 round trip, so an
 *     unpaired surrogate can never be silently replaced on the way to storage;
 *   - NUL is refused because PostgreSQL text cannot store it;
 *   - at most 1 MiB of UTF-8, matching the database check;
 *   - it is stored and returned verbatim as data. Nothing here parses Markdown,
 *     evaluates JSON, executes HTML, or turns content into a path.
 */
import { createHash } from 'node:crypto';
import { normalizeLimit } from '../persistence/pagination.js';
import { requireResourceId } from '../persistence/rows.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import {
  assertArtifactCursorScope,
  decodeArtifactCursor,
  decodeArtifactVersionCursor,
  type ArtifactCursor,
} from './cursor.js';
import type {
  ArtifactContentHash,
  ArtifactKind,
  CreateArtifactInput,
  CreateArtifactRecord,
  GetArtifactOptions,
  ListArtifactVersionsOptions,
  ListArtifactsOptions,
  UpdateArtifactInput,
  UpdateArtifactRecord,
  WritableArtifactStatus,
} from './types.js';

export const MIN_ARTIFACT_TITLE_LENGTH = 1;
export const MAX_ARTIFACT_TITLE_LENGTH = 200;
export const MAX_ARTIFACT_CONTENT_BYTES = 1_048_576;
export const MIN_ARTIFACT_VERSION = 1;
export const MAX_ARTIFACT_VERSION = 2_147_483_647;

const KINDS: ReadonlySet<string> = new Set<ArtifactKind>([
  'markdown',
  'text',
  'json',
]);
const WRITABLE_STATUSES: ReadonlySet<string> = new Set<WritableArtifactStatus>([
  'draft',
  'final',
]);

/** C0/C1 controls are refused in a title; content may keep tabs and newlines. */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }

  return false;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

export function normalizeArtifactKind(value: unknown): ArtifactKind {
  if (typeof value !== 'string' || !KINDS.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as ArtifactKind;
}

/** Accepts only the writable states; `deleted` is reached through `delete`. */
export function normalizeWritableArtifactStatus(
  value: unknown,
): WritableArtifactStatus {
  if (typeof value !== 'string' || !WRITABLE_STATUSES.has(value)) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value as WritableArtifactStatus;
}

export function normalizeArtifactTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  const title = value.trim();
  const length = characterLength(title);

  if (
    length < MIN_ARTIFACT_TITLE_LENGTH ||
    length > MAX_ARTIFACT_TITLE_LENGTH ||
    hasControlCharacters(title)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return title;
}

/**
 * Validates one generated text body. The strict round trip rejects malformed
 * UTF-16 input (an unpaired surrogate would otherwise become U+FFFD), and the
 * byte ceiling matches the database constraint.
 */
export function normalizeArtifactContent(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new PersistenceValidationError('invalid_input');
  }

  const bytes = Buffer.from(value, 'utf8');

  if (bytes.toString('utf8') !== value) {
    throw new PersistenceValidationError('invalid_input');
  }

  if (bytes.byteLength > MAX_ARTIFACT_CONTENT_BYTES) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** SHA-256 and UTF-8 length of the exact text that will be stored. */
export function hashArtifactContent(content: string): ArtifactContentHash {
  const bytes = Buffer.from(content, 'utf8');

  return {
    contentSha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.byteLength,
  };
}

export function normalizeArtifactVersion(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_ARTIFACT_VERSION ||
    value > MAX_ARTIFACT_VERSION
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

function normalizeOptionalId(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return requireResourceId(value);
}

export function normalizeCreateArtifactInput(
  input: CreateArtifactInput,
): CreateArtifactRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    kind: normalizeArtifactKind(input.kind),
    title: normalizeArtifactTitle(input.title),
    content: normalizeArtifactContent(input.content),
    conversationId: normalizeOptionalId(input.conversationId),
    runId: normalizeOptionalId(input.runId),
    status:
      input.status === undefined
        ? 'draft'
        : normalizeWritableArtifactStatus(input.status),
  };
}

export function normalizeUpdateArtifactInput(
  input: UpdateArtifactInput,
): UpdateArtifactRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    content: normalizeArtifactContent(input.content),
    title: input.title === undefined ? null : normalizeArtifactTitle(input.title),
    kind: input.kind === undefined ? null : normalizeArtifactKind(input.kind),
    status:
      input.status === undefined
        ? null
        : normalizeWritableArtifactStatus(input.status),
  };
}

/** `null` means the latest version. */
export function normalizeGetArtifactOptions(
  options: GetArtifactOptions = {},
): number | null {
  if (typeof options !== 'object' || options === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return options.version === undefined
    ? null
    : normalizeArtifactVersion(options.version);
}

export interface NormalizedListArtifactsOptions {
  conversationId: string | null;
  limit: number;
  cursor: ArtifactCursor | null;
}

export function normalizeListArtifactsOptions(
  options: ListArtifactsOptions = {},
): NormalizedListArtifactsOptions {
  if (typeof options !== 'object' || options === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  const conversationId =
    options.conversationId === undefined
      ? null
      : requireResourceId(options.conversationId);
  const cursor =
    options.cursor === undefined ? null : decodeArtifactCursor(options.cursor);

  if (cursor !== null) {
    assertArtifactCursorScope(cursor, conversationId);
  }

  return {
    conversationId,
    limit: normalizeLimit(options.limit),
    cursor,
  };
}

export interface NormalizedListArtifactVersionsOptions {
  limit: number;
  /** Only versions strictly below this number are returned. */
  beforeVersion: number | null;
}

export function normalizeListArtifactVersionsOptions(
  options: ListArtifactVersionsOptions = {},
): NormalizedListArtifactVersionsOptions {
  if (typeof options !== 'object' || options === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    limit: normalizeLimit(options.limit),
    beforeVersion:
      options.cursor === undefined
        ? null
        : decodeArtifactVersionCursor(options.cursor),
  };
}
