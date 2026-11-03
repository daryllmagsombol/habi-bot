/**
 * Closed set of extraction failures. Codes are safe to return to the caller:
 * they explain the actor's own document and never name another user, a storage
 * key, or a row id.
 *
 * Ownership failures are deliberately not part of this set. A foreign, unknown,
 * malformed, pending, rejected, or tombstoned attachment is the same
 * `PersistenceNotFoundError` (`not_found`) that H-026 already returns, so an
 * extraction lookup is not an enumeration oracle.
 */

export type ExtractionErrorCode =
  | 'unsupported_media_type'
  | 'invalid_content'
  | 'empty_content'
  | 'content_too_large'
  | 'not_extracted'
  | 'invalid_range';

const STATUS_BY_CODE: Readonly<Record<ExtractionErrorCode, number>> = {
  unsupported_media_type: 415,
  invalid_content: 422,
  empty_content: 422,
  content_too_large: 413,
  not_extracted: 409,
  invalid_range: 400,
};

/**
 * One extraction refusal. The message is the code; no document text, filename,
 * filename fragment, content type parameter, or attachment id is included.
 */
export class ExtractionError extends Error {
  readonly code: ExtractionErrorCode;
  readonly status: number;

  constructor(code: ExtractionErrorCode) {
    super(code);
    this.name = 'ExtractionError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}
