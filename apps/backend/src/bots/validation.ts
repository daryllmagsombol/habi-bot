import { PersistenceValidationError } from '../persistence/errors.js';
import type {
  CreateBotInput,
  CreateBotRecord,
  UpdateBotInput,
  UpdateBotRecord,
} from './types.js';

/** H-024 field bounds. These are validation rules, not a Bot count quota. */
export const BOT_NAME_MIN_LENGTH = 1;
export const BOT_NAME_MAX_LENGTH = 80;
export const BOT_DESCRIPTION_MAX_LENGTH = 500;
export const BOT_AVATAR_REF_MAX_LENGTH = 512;
export const BOT_INSTRUCTIONS_MAX_LENGTH = 20_000;

/**
 * C0/C1 controls except tab (`\u0009`) and line feed (`\u000a`). Carriage
 * returns are rejected so stored text has one newline convention; clients
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

/** Normalizes a creation payload. Name is required; the rest has safe defaults. */
export function normalizeCreateBotInput(input: CreateBotInput): CreateBotRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  return {
    name: normalizeBotName(input.name),
    description:
      input.description === undefined
        ? ''
        : normalizeBotDescription(input.description),
    avatarRef:
      input.avatarRef === undefined ? null : normalizeBotAvatarRef(input.avatarRef),
    instructionsMarkdown:
      input.instructionsMarkdown === undefined
        ? ''
        : normalizeBotInstructions(input.instructionsMarkdown),
  };
}

/**
 * Normalizes a patch. `undefined` leaves a field unchanged; `null` clears
 * description/instructions to `''` and avatar to `null`. An empty patch is
 * rejected so a no-op cannot silently bump `updated_at`.
 */
export function normalizeUpdateBotInput(input: UpdateBotInput): UpdateBotRecord {
  if (typeof input !== 'object' || input === null) {
    throw new PersistenceValidationError('invalid_input');
  }

  const patch: UpdateBotRecord = {};

  if (input.name !== undefined) {
    patch.name = normalizeBotName(input.name);
  }
  if (input.description !== undefined) {
    patch.description =
      input.description === null
        ? ''
        : normalizeBotDescription(input.description);
  }
  if (input.avatarRef !== undefined) {
    patch.avatarRef = normalizeBotAvatarRef(input.avatarRef);
  }
  if (input.instructionsMarkdown !== undefined) {
    patch.instructionsMarkdown =
      input.instructionsMarkdown === null
        ? ''
        : normalizeBotInstructions(input.instructionsMarkdown);
  }

  if (
    patch.name === undefined &&
    patch.description === undefined &&
    patch.avatarRef === undefined &&
    patch.instructionsMarkdown === undefined
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return patch;
}

/** Counts Unicode code points, matching PostgreSQL `char_length` on UTF-8. */
function characterLength(value: string): number {
  return Array.from(value).length;
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  return value;
}

/** Trims and validates a Bot name: 1-80 code points, no C0/C1 controls. */
export function normalizeBotName(value: unknown): string {
  const name = requireString(value).trim();
  const length = characterLength(name);

  if (
    length < BOT_NAME_MIN_LENGTH ||
    length > BOT_NAME_MAX_LENGTH ||
    hasForbiddenControlCharacters(name)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return name;
}

/** Validates free-form description text; empty is the safe default. */
export function normalizeBotDescription(value: unknown): string {
  const description = requireString(value);

  if (
    characterLength(description) > BOT_DESCRIPTION_MAX_LENGTH ||
    hasForbiddenControlCharacters(description)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return description;
}

/** Validates untrusted Markdown instructions; empty is the safe default. */
export function normalizeBotInstructions(value: unknown): string {
  const instructions = requireString(value);

  if (
    characterLength(instructions) > BOT_INSTRUCTIONS_MAX_LENGTH ||
    hasForbiddenControlCharacters(instructions)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return instructions;
}

/**
 * Validates an optional display reference. `null` clears it; an empty or
 * whitespace-only string is rejected rather than silently becoming `null`.
 */
export function normalizeBotAvatarRef(value: unknown): string | null {
  if (value === null) {
    return null;
  }

  const avatarRef = requireString(value).trim();
  const length = characterLength(avatarRef);

  if (
    length === 0 ||
    length > BOT_AVATAR_REF_MAX_LENGTH ||
    hasForbiddenControlCharacters(avatarRef)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return avatarRef;
}
