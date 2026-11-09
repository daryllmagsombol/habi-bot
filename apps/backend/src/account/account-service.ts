/**
 * H-032 (#32) account export and deletion.
 *
 * Export assembles one JSON document from owner-scoped keyset pages inside a
 * repeatable-read, read-only transaction. Nothing is buffered beyond one page
 * (and the response is written as an async iterable), so a large account does
 * not have to fit in memory. The manifest counts and the streamed rows come
 * from the same snapshot.
 *
 * Deletion runs in one transaction: it locks the identity row, verifies the
 * explicit confirmation against the server-loaded email (never against an id
 * from the request), removes private attachment objects, hard-deletes every
 * owner-scoped row, then tombstones the identity and clears credential
 * material. A retry is idempotent: the second call reports the first deletion
 * instant and removes whatever residue remains.
 *
 * Session revocation is deliberately not in this service: it lives in the HTTP
 * composition layer, where the process-wide H-017 `SessionService` is
 * available. The route revokes every live session for the owner immediately
 * after this method commits.
 */
import type { Pool } from 'pg';
import type { AttachmentStorage } from '../attachments/storage.js';
import { canonicalizeEmail } from '../auth/email.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { requireActorUserId } from '../persistence/rows.js';
import { AccountStorageUnavailableError } from './account-errors.js';
import {
  AccountRepository,
  EXPORT_SECTION_KEYS,
  type AccountProfileExport,
  type ExportCounts,
  type RemovedCounts,
} from './account-repository.js';
import {
  BACKUP_ENCRYPTION,
  BACKUP_RETENTION_DISCLOSURE,
  BACKUP_RETENTION_MAX_DAYS,
  BACKUP_RETENTION_POLICY,
} from './backup-disclosure.js';

/** v1 of the export document. A breaking shape change must bump this. */
export const ACCOUNT_EXPORT_SCHEMA_VERSION = 1;

/** Parts of the account that are deliberately never exported. */
export const ACCOUNT_EXPORT_EXCLUSIONS: readonly string[] = [
  'password hashes and credential material',
  'session secrets, session records, and CSRF tokens',
  'SSO PKCE verifiers, nonces, state/browser hashes, and pending authorizations',
  'invite and password-recovery token hashes',
  'attachment storage keys and filesystem paths',
  'internal Run request fingerprints and idempotency keys',
];

export interface AccountExportManifest {
  schemaVersion: number;
  exportedAt: string;
  accountId: string;
  counts: ExportCounts;
  excluded: readonly string[];
}

export interface BackupRetentionDisclosure {
  encrypted: true;
  encryption: string;
  policy: string;
  maximumDays: number;
  disclosure: string;
}

export interface AccountDeletionResult {
  deleted: true;
  accountId: string;
  deletedAt: string;
  alreadyDeleted: boolean;
  removed: RemovedCounts;
  backupRetention: BackupRetentionDisclosure;
}

export interface AccountDeletionResponse extends AccountDeletionResult {
  /** Live sessions revoked by the HTTP layer in this request. */
  sessionsRevoked: number;
}

export class AccountService {
  private readonly repository: AccountRepository;

  constructor(
    private readonly pool: Pool,
    private readonly storage: AttachmentStorage | undefined,
  ) {
    this.repository = new AccountRepository();
  }

  /**
   * Fails before any streaming headers are written when the authenticated
   * account is not a live identity row. Foreign or tombstoned ids never reach
   * a stream.
   */
  async assertExportable(actorUserId: string): Promise<AccountProfileExport> {
    const userId = requireActorUserId(actorUserId);
    const client = await this.pool.connect();

    try {
      const profile = await this.repository.loadExportProfile(client, userId);

      if (profile === null) {
        throw new PersistenceNotFoundError();
      }

      return profile;
    } finally {
      client.release();
    }
  }

  /**
   * Streams the export as JSON text chunks. The caller pipes them to the
   * response; closing the iterator early rolls the snapshot transaction back.
   */
  async *export(actorUserId: string): AsyncGenerator<string> {
    const userId = requireActorUserId(actorUserId);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      inTransaction = true;

      const profile = await this.repository.loadExportProfile(client, userId);

      if (profile === null) {
        throw new PersistenceNotFoundError();
      }

      const counts = await this.repository.countExport(client, userId);
      const manifest: AccountExportManifest = {
        schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        accountId: userId,
        counts,
        excluded: ACCOUNT_EXPORT_EXCLUSIONS,
      };

      yield '{';
      yield `"manifest":${JSON.stringify(manifest)}`;
      yield `,"profile":${JSON.stringify(profile)}`;

      for (const key of EXPORT_SECTION_KEYS) {
        yield `,"${key}":[`;
        let first = true;

        for await (const row of this.repository.streamSection(
          client,
          userId,
          key,
        )) {
          yield `${first ? '' : ','}${JSON.stringify(row)}`;
          first = false;
        }

        yield ']';
      }

      yield '}';

      await client.query('COMMIT');
      inTransaction = false;
    } catch (error) {
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => {});
      }
      throw error;
    } finally {
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => {});
      }
      client.release();
    }
  }

  /**
   * Deletes the authenticated account. `confirmation` is compared with the
   * server-loaded email after canonicalization; it is never used to select an
   * account. A missing, malformed, or wrong value is refused with the normal
   * `invalid_input` envelope.
   */
  async deleteAccount(
    actorUserId: string,
    confirmation: unknown,
  ): Promise<AccountDeletionResult> {
    const userId = requireActorUserId(actorUserId);
    const confirmationEmail =
      typeof confirmation === 'string' ? canonicalizeEmail(confirmation) : undefined;
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query('BEGIN');
      inTransaction = true;

      const state = await this.repository.lockAccount(client, userId);

      if (state === null) {
        throw new PersistenceNotFoundError();
      }

      if (state.status !== 'deleted') {
        if (
          confirmationEmail === undefined ||
          state.email === null ||
          confirmationEmail !== state.email
        ) {
          throw new PersistenceValidationError('invalid_input');
        }
      }

      // Bytes live outside PostgreSQL. Remove them before the rows so a storage
      // failure leaves a retryable account instead of a row that points at
      // content this process could no longer delete.
      const locators = await this.repository.attachmentLocators(client, userId);

      if (locators.length > 0) {
        if (this.storage === undefined) {
          throw new AccountStorageUnavailableError();
        }

        for (const locator of locators) {
          await this.storage.deleteObject({
            ownerUserId: userId,
            conversationId: locator.conversationId,
            attachmentId: locator.attachmentId,
          });
        }
      }

      const removed = await this.repository.deleteOwnedRows(client, userId);
      const deletedAt = await this.repository.tombstoneAccount(
        client,
        userId,
        state,
      );

      await client.query('COMMIT');
      inTransaction = false;

      return {
        deleted: true,
        accountId: userId,
        deletedAt,
        alreadyDeleted: state.status === 'deleted',
        removed,
        backupRetention: {
          encrypted: true,
          encryption: BACKUP_ENCRYPTION,
          policy: BACKUP_RETENTION_POLICY,
          maximumDays: BACKUP_RETENTION_MAX_DAYS,
          disclosure: BACKUP_RETENTION_DISCLOSURE,
        },
      };
    } catch (error) {
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => {});
      }
      throw error;
    } finally {
      if (inTransaction) {
        await client.query('ROLLBACK').catch(() => {});
      }
      client.release();
    }
  }
}
