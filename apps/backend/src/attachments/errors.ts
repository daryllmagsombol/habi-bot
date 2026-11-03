/**
 * Attachment-specific failures. Ownership, unknown ids, tombstoned rows, and
 * malformed ids all reuse `PersistenceNotFoundError` so there is exactly one
 * non-enumerating not-found outcome across the service.
 */

/**
 * The stored bytes do not match the metadata the row recorded (wrong digest,
 * wrong length, or a missing object). Ownership was already proven, so this is
 * an integrity failure rather than an existence signal.
 */
export class AttachmentIntegrityError extends Error {
  readonly code = 'attachment_integrity' as const;

  constructor() {
    super('attachment_integrity');
    this.name = 'AttachmentIntegrityError';
  }
}

/** Policy refused the content. The row is `rejected` and never downloadable. */
export class AttachmentRejectedError extends Error {
  readonly code = 'attachment_rejected' as const;

  constructor() {
    super('attachment_rejected');
    this.name = 'AttachmentRejectedError';
  }
}
