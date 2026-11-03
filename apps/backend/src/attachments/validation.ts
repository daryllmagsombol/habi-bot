/**
 * H-026 (#26) upload validation.
 *
 * Every check here runs after the actor/conversation ownership lookup, so a
 * rejected value never reveals whether the conversation exists. The declared
 * MIME type is an allow-list, not a trust signal: content inspection and
 * extraction belong to later lanes, and file content never grants capability.
 */
import { PersistenceValidationError } from '../persistence/errors.js';
import type { CreateAttachmentUploadInput } from './types.js';

/** Per-file ceiling. The migration repeats this bound as a check constraint. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Display-name bound. The migration repeats this bound as a check constraint. */
export const MAX_ATTACHMENT_FILENAME_LENGTH = 255;

/**
 * Initial file-type decision (H-026 decision 3): plain text, Markdown, PDF, and
 * PNG/JPEG images. Everything else is rejected, including active content such
 * as HTML, SVG, and executables. The list is intentionally small and ordered.
 */
export const ALLOWED_ATTACHMENT_CONTENT_TYPES: readonly string[] = [
  'text/markdown',
  'text/plain',
  'application/pdf',
  'image/png',
  'image/jpeg',
];

const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(
  ALLOWED_ATTACHMENT_CONTENT_TYPES,
);

/** C0/C1 controls except tab and line feed; NUL is covered by this range. */
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

function invalid(): never {
  throw new PersistenceValidationError('invalid_input');
}

/**
 * Accepts only an allow-listed MIME essence. Parameters are dropped, case is
 * normalized, and anything path-shaped or unknown is rejected.
 */
export function normalizeAttachmentContentType(value: unknown): string {
  if (typeof value !== 'string') {
    invalid();
  }

  const essence = value.split(';')[0]?.trim().toLowerCase() ?? '';

  if (
    essence.length === 0 ||
    essence.length > 255 ||
    hasForbiddenControlCharacters(essence) ||
    !ALLOWED_CONTENT_TYPES.has(essence)
  ) {
    invalid();
  }

  return essence;
}

/**
 * A filename is display metadata only. It must not look like a path: no
 * separators, no drive prefix, no traversal segments, no NUL, no controls.
 * No caller-supplied value ever reaches the storage key.
 */
export function normalizeAttachmentFilename(value: unknown): string {
  if (typeof value !== 'string') {
    invalid();
  }

  const filename = value.trim();
  const characterLength = Array.from(filename).length;

  if (
    characterLength === 0 ||
    characterLength > MAX_ATTACHMENT_FILENAME_LENGTH ||
    filename === '.' ||
    filename === '..' ||
    filename.startsWith('/') ||
    /^[a-zA-Z]:/.test(filename) ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes('..') ||
    hasForbiddenControlCharacters(filename)
  ) {
    invalid();
  }

  return filename;
}

/** Validates the upload envelope before a single byte is written. */
export function normalizeCreateAttachmentUpload(
  input: CreateAttachmentUploadInput,
): CreateAttachmentUploadInput {
  if (typeof input !== 'object' || input === null) {
    invalid();
  }

  if (typeof input.source !== 'object' || input.source === null) {
    invalid();
  }

  if (typeof input.source[Symbol.asyncIterator] !== 'function') {
    invalid();
  }

  return {
    filename: normalizeAttachmentFilename(input.filename),
    contentType: normalizeAttachmentContentType(input.contentType),
    source: input.source,
  };
}
