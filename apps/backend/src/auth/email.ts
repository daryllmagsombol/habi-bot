/**
 * Canonical email handling for the H-014 identity slice.
 *
 * H-008 §7.2 requires one canonical login/recovery address per active account.
 * This slice trims surrounding whitespace and lowercases the whole address, as
 * the H-014 slice spec requires (`citext`-like storage). It deliberately does
 * not rewrite the local part: no dot/plus stripping and no provider-specific
 * alias rules.
 *
 * The canonicalizer returns `undefined` for malformed input instead of throwing
 * so callers choose their own non-enumerating response. It is the only function
 * allowed to produce a value stored in `users.email` or `invites.email`.
 */

export const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;

/**
 * Minimal, dependency-free shape check: exactly one `@`, non-empty local part,
 * a dotted domain, no whitespace or control characters. Full RFC 5322 parsing
 * is not attempted and is not required to store a canonical identifier.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

export function canonicalizeEmail(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();

  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) {
    return undefined;
  }

  if (hasControlCharacter(trimmed)) {
    return undefined;
  }

  const canonical = trimmed.toLowerCase();
  const separator = canonical.indexOf('@');

  if (separator <= 0 || separator !== canonical.lastIndexOf('@')) {
    return undefined;
  }

  if (separator > MAX_LOCAL_PART_LENGTH) {
    return undefined;
  }

  if (!EMAIL_SHAPE.test(canonical)) {
    return undefined;
  }

  return canonical;
}
