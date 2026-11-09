/**
 * H-032 (#32) error for an account deletion that cannot honestly remove every
 * copy it is responsible for.
 *
 * Attachment bytes live outside PostgreSQL. When the owner has attachment rows
 * but this process has no configured private storage root, the deletion is
 * refused before anything is changed rather than reporting a live-data erase
 * while leaving files on disk. The error carries no owner id, path, or count.
 */
export class AccountStorageUnavailableError extends Error {
  readonly code = 'account_storage_unavailable';

  constructor() {
    super('account_storage_unavailable');
    this.name = 'AccountStorageUnavailableError';
  }
}
