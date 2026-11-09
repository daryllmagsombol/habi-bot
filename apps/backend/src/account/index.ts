/**
 * H-032 (#32) export/delete composition. Importing this barrel opens no
 * connection and registers nothing; the HTTP module decides when it exists.
 */
export { AccountService } from './account-service.js';
export type {
  AccountDeletionResponse,
  AccountDeletionResult,
  AccountExportManifest,
  AccountServiceOptions,
  BackupRetentionDisclosure,
  RunReconciliationSummary,
} from './account-service.js';
export {
  ACCOUNT_EXPORT_EXCLUSIONS,
  ACCOUNT_EXPORT_SCHEMA_VERSION,
  DEFAULT_ACCOUNT_RUN_CANCEL_WAIT_MS,
} from './account-service.js';
export {
  AccountRuntime,
  ATTACHMENT_STORAGE_ROOT_ENV,
  RUN_CANCEL_WAIT_ENV,
} from './account-runtime.js';
export { AccountStorageUnavailableError } from './account-errors.js';
export {
  BACKUP_ENCRYPTION,
  BACKUP_RETENTION_DISCLOSURE,
  BACKUP_RETENTION_MAX_DAYS,
  BACKUP_RETENTION_POLICY,
} from './backup-disclosure.js';
export type {
  AccountAuditAction,
  AccountAuditEntry,
  AccountAuditOutcome,
  AccountAuditPage,
  AccountDeletionState,
  AccountProfileExport,
  AttachmentLocator,
  DeletionAuditInput,
  ExportCounts,
  ExportSectionKey,
  RemovedCounts,
} from './account-repository.js';
