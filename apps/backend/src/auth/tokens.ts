/**
 * Invite and recovery token helpers.
 *
 * Tokens are 256-bit CSPRNG values, base64url encoded. Only the SHA-256 hash is
 * stored (`invites.token_hash`, `password_reset_tokens.token_hash`); the raw
 * token is returned to the caller once and, for recovery, intentionally
 * discarded because email delivery is not part of this slice. A fast unkeyed
 * hash is sufficient here because the input already has 256 bits of entropy;
 * there is no password-style guessing surface.
 */
import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_BYTES = 32;
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
