/** H-026 (#26) attachment vocabulary and metadata shapes. */

/** Migration 0007 lifecycle. `deleted` is a tombstone, not a hard delete. */
export type AttachmentStatus = 'pending' | 'stored' | 'rejected' | 'deleted';

/**
 * Downloadable metadata for one attachment. The server-generated `storageKey`
 * is deliberately absent: clients get metadata and authorized bytes, never a
 * path or object key they could use directly.
 */
export interface AttachmentMetadata {
  id: string;
  conversationId: string;
  messageId: string | null;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  /** Lowercase hex SHA-256 of the bytes as stored. */
  sha256: string;
  status: AttachmentStatus;
  createdAt: string;
  storedAt: string | null;
  deletedAt: string | null;
}

/** Bytes together with the metadata that was verified against them. */
export interface AttachmentContent {
  metadata: AttachmentMetadata;
  content: Buffer;
}

/**
 * Upload input. `source` is consumed once, in order, and is never buffered
 * before hashing and the size check. `filename` is display metadata only.
 */
export interface CreateAttachmentUploadInput {
  filename: string;
  /** Declared MIME type; must be one of the allow-listed values. */
  contentType: string;
  source: AsyncIterable<Uint8Array>;
}

export interface ListAttachmentsOptions {
  limit?: number;
}

/** Internal row shape returned by the repository. Never crosses the service API. */
export interface AttachmentRecord extends AttachmentMetadata {
  ownerUserId: string;
  storageKey: string;
}
