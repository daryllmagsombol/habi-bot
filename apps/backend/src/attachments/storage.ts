/**
 * Private attachment object storage.
 *
 * Only server-generated ids reach the filesystem layout:
 *
 *   <root>/owner/<owner-uuid>/conversation/<conversation-uuid>/<attachment-uuid>
 *
 * A client filename, MIME type, or any other requested path is never a part of
 * the key. Writes stream to a temporary file in the destination directory,
 * fsync, and rename, so a reader never observes a partial object. Reads hash
 * the bytes again and compare them with the metadata row before returning.
 *
 * This interface is the seam for a later object-store implementation. The local
 * filesystem implementation is the only one provided in this slice.
 *
 * Malware handling: `AttachmentScanner` is a documented hook only. No scanner,
 * sandbox, or quarantine service is implemented or claimed. When a scanner is
 * supplied, a `reject` decision is observable as the `rejected` row state and
 * the stored object is removed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isUuid } from '../persistence/cursor.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import { AttachmentIntegrityError } from './errors.js';

/** Server-owned coordinates for exactly one object. Never accepted from a client. */
export interface AttachmentObjectLocator {
  ownerUserId: string;
  conversationId: string;
  attachmentId: string;
}

/** Result of one streaming write. */
export interface AttachmentObjectInfo {
  byteSize: number;
  sha256: string;
}

/** Metadata handed to a scanner hook; it never receives local paths. */
export interface AttachmentScanInput {
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
}

export type AttachmentScanDecision = { verdict: 'allow' } | { verdict: 'reject' };

/**
 * Optional content-inspection seam. Implementations are not provided here; a
 * future lane may add an external scanner adapter behind this interface.
 */
export interface AttachmentScanner {
  scan(input: AttachmentScanInput): Promise<AttachmentScanDecision>;
}

export interface AttachmentStorage {
  /** Streams `source` once, enforces `maxBytes`, and writes atomically. */
  putObject(
    locator: AttachmentObjectLocator,
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<AttachmentObjectInfo>;
  /** Reads one object and fails closed if length or SHA-256 disagree. */
  getObject(locator: AttachmentObjectLocator, expected: AttachmentObjectInfo): Promise<Buffer>;
  /** Removes one object. Missing objects are already deleted, not an error. */
  deleteObject(locator: AttachmentObjectLocator): Promise<void>;
}

const UUID_SHAPE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const STORAGE_KEY_PATTERN = new RegExp(
  `^owner/${UUID_SHAPE}/conversation/${UUID_SHAPE}/${UUID_SHAPE}$`,
);

function requireUuid(value: unknown): string {
  if (!isUuid(value)) {
    throw new TypeError('Invalid attachment storage locator.');
  }
  return value;
}

/**
 * Builds the only legal object key. Every component is a server-generated UUID;
 * anything else is a programming error and throws a fixed-message TypeError.
 */
export function buildAttachmentStorageKey(locator: AttachmentObjectLocator): string {
  const ownerUserId = requireUuid(locator.ownerUserId);
  const conversationId = requireUuid(locator.conversationId);
  const attachmentId = requireUuid(locator.attachmentId);

  return `owner/${ownerUserId}/conversation/${conversationId}/${attachmentId}`;
}

/** True only for a key this module would generate. Used by tests and diagnostics. */
export function isAttachmentStorageKey(value: unknown): value is string {
  return typeof value === 'string' && STORAGE_KEY_PATTERN.test(value);
}

/**
 * Local filesystem implementation rooted at an injected absolute directory.
 * The directory is created with owner-only permissions when `initialize` runs;
 * no public URL exists and nothing is served by the web tier.
 */
export class LocalAttachmentStorage implements AttachmentStorage {
  private readonly rootDir: string;

  constructor(rootDirectory: string) {
    if (typeof rootDirectory !== 'string' || rootDirectory.length === 0) {
      throw new TypeError('Attachment storage root is required.');
    }

    if (!isAbsolute(rootDirectory)) {
      throw new TypeError('Attachment storage root must be an absolute path.');
    }

    this.rootDir = resolve(rootDirectory);
  }

  /** Creates the private root. Idempotent; storage methods also create subdirs. */
  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
  }

  async putObject(
    locator: AttachmentObjectLocator,
    source: AsyncIterable<Uint8Array>,
    maxBytes: number,
  ): Promise<AttachmentObjectInfo> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new TypeError('Attachment size ceiling is invalid.');
    }

    const objectPath = this.objectPath(locator);
    const directory = dirname(objectPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    // The temporary name lives in the destination directory so rename is
    // atomic on the same filesystem and never crosses a mount boundary.
    const temporaryPath = join(directory, `.upload-${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let byteSize = 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;

    try {
      handle = await open(temporaryPath, 'wx', 0o600);

      for await (const chunk of source) {
        if (!(chunk instanceof Uint8Array)) {
          throw new PersistenceValidationError('invalid_input');
        }

        if (chunk.byteLength === 0) {
          continue;
        }

        byteSize += chunk.byteLength;
        if (byteSize > maxBytes) {
          // The stream is abandoned here; the partial temp file is removed
          // below and no metadata row exists for an oversized upload.
          throw new PersistenceValidationError('invalid_input');
        }

        hash.update(chunk);

        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
          );

          if (bytesWritten <= 0) {
            throw new Error('Attachment storage write made no progress.');
          }

          offset += bytesWritten;
        }
      }

      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, objectPath);
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => {});
      }
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }

    return { byteSize, sha256: hash.digest('hex') };
  }

  async getObject(
    locator: AttachmentObjectLocator,
    expected: AttachmentObjectInfo,
  ): Promise<Buffer> {
    const objectPath = this.objectPath(locator);

    let content: Buffer;
    try {
      content = await readFile(objectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The row exists but its bytes do not: fail closed, never serve.
        throw new AttachmentIntegrityError();
      }
      throw error;
    }

    const digest = createHash('sha256').update(content).digest('hex');

    if (content.byteLength !== expected.byteSize || digest !== expected.sha256) {
      throw new AttachmentIntegrityError();
    }

    return content;
  }

  async deleteObject(locator: AttachmentObjectLocator): Promise<void> {
    const objectPath = this.objectPath(locator);

    try {
      await unlink(objectPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Already removed; deletion is idempotent.
        return;
      }
      throw error;
    }
  }

  /**
   * Maps a locator to an absolute path and re-checks containment after
   * resolution. UUID validation plus containment makes traversal impossible
   * even if a future caller violates the interface contract.
   */
  private objectPath(locator: AttachmentObjectLocator): string {
    const key = buildAttachmentStorageKey(locator);
    const absolutePath = resolve(this.rootDir, key);

    if (!absolutePath.startsWith(`${this.rootDir}${sep}`)) {
      throw new TypeError('Attachment storage path escaped its root.');
    }

    return absolutePath;
  }
}
