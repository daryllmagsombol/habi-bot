/**
 * H-032 (#32) account export and deletion.
 *
 * Export assembles one JSON document from owner-scoped keyset pages inside a
 * repeatable-read, read-only transaction. Nothing is buffered beyond one page
 * (and the response is written as an async iterable), so a large account does
 * not have to fit in memory. The manifest counts and the streamed rows come
 * from the same snapshot.
 *
 * Deletion first validates the request, then writes the durable cancel intent
 * for every non-terminal Run the account owns and waits a bounded time for a
 * present worker to terminalize them. It then runs one transaction: it locks
 * the identity row, verifies the explicit confirmation against the
 * server-loaded email (never against an id from the request), removes private
 * attachment objects, hard-deletes every owner-scoped row (including the
 * account's own audit trail), tombstones the identity and clears credential
 * material, and writes the surviving deletion audit record. A retry is
 * idempotent: the second call reports the first deletion instant and removes
 * whatever residue remains.
 *
 * Runs that did not terminalize inside the bound are reported as
 * `unreconciledRuns`. This process has no adapter and cannot stop an adapter
 * call a worker already has in flight.
 *
 * Session revocation is deliberately not in this service: it lives in the HTTP
 * composition layer, where the process-wide H-017 `SessionService` is
 * available. The route revokes every live session for the owner immediately
 * after this method commits.
 */
import type { Pool, PoolClient } from 'pg';
import type { AttachmentStorage } from '../attachments/storage.js';
import { canonicalizeEmail } from '../auth/email.js';
import {
  PersistenceNotFoundError,
  PersistenceValidationError,
} from '../persistence/errors.js';
import { normalizeLimit } from '../persistence/pagination.js';
import type { Queryable } from '../persistence/database.js';
import { requireActorUserId } from '../persistence/rows.js';
import { RunRepository } from '../runs/run-repository.js';
import { AccountStorageUnavailableError } from './account-errors.js';
import {
  AccountRepository,
  EXPORT_SECTION_KEYS,
  type AccountAuditPage,
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
  /**
   * What actually happened to the account's non-terminal Runs. `requested` is
   * how many durable cancel intents were written; `reconciled` is how many
   * became terminal inside the wait bound; `unreconciledRuns` names the ones
   * that did not. A non-empty list is the honest answer: the API has no adapter
   * and cannot stop an adapter call that a worker process already has in
   * flight, and their rows were removed with the account regardless.
   */
  runReconciliation: RunReconciliationSummary;
  backupRetention: BackupRetentionDisclosure;
}

export interface RunReconciliationSummary {
  requested: number;
  reconciled: number;
  unreconciledRuns: readonly string[];
  waitedMillis: number;
}

/** Bound for waiting on a present worker to terminalize a cancelled Run. */
export const DEFAULT_ACCOUNT_RUN_CANCEL_WAIT_MS = 3000;

/** How often the bound is checked for terminalized Runs. */
const RUN_CANCEL_POLL_MS = 50;

export interface AccountServiceOptions {
  /** Overrides {@link DEFAULT_ACCOUNT_RUN_CANCEL_WAIT_MS}. */
  runCancelWaitMs?: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * The confirmation must be the server-loaded email, canonicalized on both
 * sides. It never selects an account; it only proves the caller meant this one.
 */
/**
 * An already-deleted account needs no confirmation: the request is a repeat
 * and the outcome is the same tombstone. Everything else must match.
 */
function isConfirmationSatisfied(
  state: { readonly status: string },
  confirmationEmail: string | undefined,
): boolean {
  return (
    state.status === 'deleted' ||
    matchesConfirmation(state as never, confirmationEmail)
  );
}

function matchesConfirmation(
  state: { email: string | null },
  confirmationEmail: string | undefined,
): boolean {
  return (
    confirmationEmail !== undefined &&
    state.email !== null &&
    confirmationEmail === state.email
  );
}

export interface AccountDeletionResponse extends AccountDeletionResult {
  /** Live sessions revoked by the HTTP layer in this request. */
  sessionsRevoked: number;
}

export class AccountService {
  private readonly repository: AccountRepository;
  private readonly runs: RunRepository;
  private readonly runCancelWaitMs: number;

  constructor(
    private readonly pool: Pool,
    private readonly storage: AttachmentStorage | undefined,
    options: AccountServiceOptions = {},
  ) {
    this.repository = new AccountRepository();
    this.runs = new RunRepository(pool);
    this.runCancelWaitMs =
      options.runCancelWaitMs ?? DEFAULT_ACCOUNT_RUN_CANCEL_WAIT_MS;
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

      // Audit the request with the counts this snapshot reports, before the
      // first body byte. The snapshot transaction is READ ONLY, so the row is
      // written on its own connection and committed immediately; that is what
      // lets a streamed (or client-aborted) export still leave a durable
      // record. If this insert fails the export does not proceed.
      await this.repository.insertExportAudit(this.pool, userId, counts);

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
   * One owner-scoped page of the audit trail. Ownership is the session actor;
   * there is no query parameter that selects an account.
   */
  async listAudit(
    actorUserId: string,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<AccountAuditPage> {
    const userId = requireActorUserId(actorUserId);

    if (cursor !== undefined && !/^\d+$/.test(cursor)) {
      throw new PersistenceValidationError('invalid_cursor');
    }

    const client = await this.pool.connect();

    try {
      return await this.repository.listAudit(
        client,
        userId,
        cursor ?? null,
        normalizeLimit(limit),
      );
    } finally {
      client.release();
    }
  }

  /**
   * Writes a durable cancel intent for every non-terminal Run this account
   * owns, then waits a bounded time for a present worker to terminalize them.
   *
   * This is the same mechanism a user cancel uses (`requestCancel`), not a
   * second control path. The API has no adapter, so an adapter call a worker
   * already has in flight is not stopped here; the response reports that
   * honestly instead of claiming a stop.
   */
  private async reconcileRuns(userId: string): Promise<RunReconciliationSummary> {
    const runIds = await this.repository.listNonTerminalRunIds(this.pool, userId);

    if (runIds.length === 0) {
      return {
        requested: 0,
        reconciled: 0,
        unreconciledRuns: [],
        waitedMillis: 0,
      };
    }

    for (const runId of runIds) {
      await this.runs.requestCancel(runId, userId, 'user');
    }

    const startedAt = Date.now();
    const deadline = startedAt + this.runCancelWaitMs;
    let outstanding = runIds;

    while (outstanding.length > 0) {
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        break;
      }

      await sleep(Math.min(RUN_CANCEL_POLL_MS, remaining));
      outstanding = await this.repository.listOutstandingRunIds(
        this.pool,
        userId,
        runIds,
      );
    }

    return {
      requested: runIds.length,
      reconciled: runIds.length - outstanding.length,
      unreconciledRuns: outstanding,
      waitedMillis: Date.now() - startedAt,
    };
  }

  /**
   * Deletes the authenticated account. `confirmation` is compared with the
   * server-loaded email after canonicalization; it is never used to select an
   * account. A missing, malformed, or wrong value is refused with the normal
   * `invalid_input` envelope, and the refusal is audited without changing any
   * account data.
   *
   * Order matters:
   *
   *   1. validate the request against an unlocked read, so a refused request
   *      never cancels a Run;
   *   2. write the durable cancel intents and wait (bounded) for a worker to
   *      terminalize the account's non-terminal Runs;
   *   3. run the deletion transaction: lock the identity, verify the
   *      confirmation again, remove storage bytes, purge owned rows (including
   *      the account's own audit trail), tombstone the identity, and write the
   *      surviving deletion record in the same transaction.
   *
   * A Run that did not terminalize inside the bound is listed in
   * `runReconciliation.unreconciledRuns`; its row is still removed, and an
   * adapter call already in flight in a worker is not stopped by this process.
   */
  async deleteAccount(
    actorUserId: string,
    confirmation: unknown,
  ): Promise<AccountDeletionResult> {
    const userId = requireActorUserId(actorUserId);
    const confirmationEmail =
      typeof confirmation === 'string' ? canonicalizeEmail(confirmation) : undefined;
    const preflight = await this.repository.readAccountState(this.pool, userId);

    if (preflight === null) {
      throw new PersistenceNotFoundError();
    }

    if (!isConfirmationSatisfied(preflight, confirmationEmail)) {
      await this.recordRefusal(this.pool, userId, confirmationEmail);
      throw new PersistenceValidationError('invalid_input');
    }

    const runReconciliation = await this.reconcileRuns(userId);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query('BEGIN');
      inTransaction = true;

      const state = await this.repository.lockAccount(client, userId);

      if (state === null) {
        throw new PersistenceNotFoundError();
      }

      if (!isConfirmationSatisfied(state, confirmationEmail)) {
        // The email changed between the preflight and the lock. Commit the
        // refusal record, then report the refusal.
        await this.recordRefusal(client, userId, confirmationEmail);
        await client.query('COMMIT');
        inTransaction = false;
        throw new PersistenceValidationError('invalid_input');
      }

      await this.removeAttachmentBytes(client, userId);

      const removed = await this.repository.deleteOwnedRows(client, userId);
      const deletedAt = await this.repository.tombstoneAccount(
        client,
        userId,
        state,
      );
      const alreadyDeleted = state.status === 'deleted';

      await this.recordDeletion(client, {
        actorUserId: userId,
        alreadyDeleted,
        removed,
        runReconciliation,
      });

      await client.query('COMMIT');
      inTransaction = false;

      return {
        deleted: true,
        accountId: userId,
        deletedAt,
        alreadyDeleted,
        removed,
        runReconciliation,
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

  /**
   * Bytes live outside PostgreSQL. They are removed before the rows so a
   * storage failure leaves a retryable account instead of rows pointing at
   * content this process could no longer delete.
   */
  private async removeAttachmentBytes(
    client: PoolClient,
    userId: string,
  ): Promise<void> {
    const locators = await this.repository.attachmentLocators(client, userId);

    if (locators.length === 0) {
      return;
    }

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

  /**
   * The account's own audit rows were removed with the rest of its data. This
   * record is the exception: NULL owner, so it outlives the deletion and is
   * never reachable from an owner-scoped read.
   */
  private async recordDeletion(
    client: PoolClient,
    input: {
      readonly actorUserId: string;
      readonly alreadyDeleted: boolean;
      readonly removed: Readonly<Record<string, number>>;
      readonly runReconciliation: RunReconciliationSummary;
    },
  ): Promise<void> {
    await this.repository.insertDeletionAudit(client, {
      ownerUserId: null,
      actorUserId: input.actorUserId,
      outcome: input.alreadyDeleted ? 'already_deleted' : 'deleted',
      detail: { removed: input.removed, runReconciliation: input.runReconciliation },
    });
  }

  /**
   * Records a refused deletion. The account was not touched, so the row is
   * ordinary owner-scoped account data and is removed by a later successful
   * deletion.
   */
  private async recordRefusal(
    client: Queryable,
    ownerUserId: string,
    confirmationEmail: string | undefined,
  ): Promise<void> {
    await this.repository.insertDeletionAudit(client, {
      ownerUserId,
      actorUserId: ownerUserId,
      outcome: 'refused',
      detail: {
        reason:
          confirmationEmail === undefined
            ? 'confirmation_invalid'
            : 'confirmation_mismatch',
      },
    });
  }
}
