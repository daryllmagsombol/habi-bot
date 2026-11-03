/**
 * Dependency-free password hashing for the H-014 identity slice.
 *
 * `node:crypto` scrypt is the only primitive; no password-hashing dependency is
 * added. The stored value is versioned so parameters and the algorithm can be
 * upgraded without guessing:
 *
 *   scrypt$1$<cost>$<blockSize>$<parallelization>$<salt base64url>$<key base64url>
 *
 * - A 16-byte CSPRNG salt is generated per hash; no pepper is used because the
 *   repository has no approved secret-storage mechanism yet (#17).
 * - `cost=32768, blockSize=8, parallelization=1, keyLength=32` is the current
 *   profile (roughly 32 MiB, tens of milliseconds on a developer laptop). These
 *   are deliberate POC defaults, not owner-approved production parameters.
 * - Verification recomputes the key and compares with `timingSafeEqual`.
 * - Parsing validates every parameter so a corrupted or hostile stored hash
 *   cannot turn verification into an unbounded memory/cpu request.
 *
 * Unknown users still run a dummy verify against `DUMMY_PASSWORD_HASH` so login
 * failure timing does not distinguish "no such email" from "wrong password".
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

const FORMAT_PREFIX = 'scrypt';
const FORMAT_VERSION = '1';
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const DEFAULT_COST = 32768;
const DEFAULT_BLOCK_SIZE = 8;
const DEFAULT_PARALLELIZATION = 1;
const MIN_COST = 1024;
const MAX_COST = 1 << 17;
const MAX_BLOCK_SIZE = 8;
const MAX_PARALLELIZATION = 2;

/**
 * A valid scrypt hash of a fixed, non-secret dummy string. It exists only to
 * spend the same verification work when no credential row was found. It must
 * never be accepted as an account password hash because no account stores it.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$1$32768$8$1$SDvooMATEwbEkmipkRIoMA$0Fs9mv6N1WI-C_tVoa_zI_U09F3mJc718yqzdz1-ykI';

export type PasswordPolicyFailure = 'too_short' | 'too_long' | 'matches_email';

/**
 * Minimum policy: at least 12 characters and not equal to the canonical email.
 * No composition rules are imposed because they do not materially improve
 * strength at this length. The comparison is case-insensitive against the
 * already-canonical lowercase address.
 */
export function validatePassword(
  password: string,
  canonicalEmail: string,
): PasswordPolicyFailure | 'ok' {
  const length = Array.from(password).length;

  if (length < MIN_PASSWORD_LENGTH) {
    return 'too_short';
  }

  if (length > MAX_PASSWORD_LENGTH) {
    return 'too_long';
  }

  if (password.toLowerCase() === canonicalEmail) {
    return 'matches_email';
  }

  return 'ok';
}

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error !== null) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}

interface ParsedHash {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelization: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parseHash(stored: string | null | undefined): ParsedHash | undefined {
  if (typeof stored !== 'string') {
    return undefined;
  }

  const parts = stored.split('$');

  if (parts.length !== 7 || parts[0] !== FORMAT_PREFIX || parts[1] !== FORMAT_VERSION) {
    return undefined;
  }

  const cost = Number(parts[2]);
  const blockSize = Number(parts[3]);
  const parallelization = Number(parts[4]);

  if (
    !Number.isInteger(cost) ||
    cost < MIN_COST ||
    cost > MAX_COST ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > MAX_BLOCK_SIZE ||
    !Number.isInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > MAX_PARALLELIZATION
  ) {
    return undefined;
  }

  let salt: Buffer;
  let key: Buffer;

  try {
    salt = Buffer.from(parts[5] ?? '', 'base64url');
    key = Buffer.from(parts[6] ?? '', 'base64url');
  } catch {
    return undefined;
  }

  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) {
    return undefined;
  }

  return { cost, blockSize, parallelization, salt, key };
}

function maxMemoryBytes(cost: number, blockSize: number): number {
  // scrypt needs roughly 128 * N * r bytes; leave headroom for Node overhead.
  return Math.max(64 * 1024 * 1024, 128 * cost * blockSize * 2);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_BYTES, {
    cost: DEFAULT_COST,
    blockSize: DEFAULT_BLOCK_SIZE,
    parallelization: DEFAULT_PARALLELIZATION,
    maxmem: maxMemoryBytes(DEFAULT_COST, DEFAULT_BLOCK_SIZE),
  });

  return [
    FORMAT_PREFIX,
    FORMAT_VERSION,
    String(DEFAULT_COST),
    String(DEFAULT_BLOCK_SIZE),
    String(DEFAULT_PARALLELIZATION),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  const parsed = parseHash(stored);

  if (parsed === undefined) {
    return false;
  }

  const derived = await scryptAsync(password, parsed.salt, parsed.key.length, {
    cost: parsed.cost,
    blockSize: parsed.blockSize,
    parallelization: parsed.parallelization,
    maxmem: maxMemoryBytes(parsed.cost, parsed.blockSize),
  });

  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}
