/**
 * H-027 (#27) ExtractionService: bounded extraction and exact citation for
 * attachments that can be decoded without a new dependency.
 *
 * Supported formats:
 *   - `text/markdown`
 *   - `text/plain`
 *
 * PDF is deliberately NOT supported in this slice. A dependency-free,
 * trustworthy PDF text extractor does not exist in the runtime: parsing a PDF
 * requires a library, decompression of content streams, font/encoding mapping,
 * and page-bound checks. Adding `pdfjs-dist` or an equivalent package is outside
 * this lane's no-new-dependency boundary, so `application/pdf` is refused as
 * `unsupported_media_type`. Images are refused the same way. The structured
 * PDF follow-up (bounded page count, encrypted/scanned detection, per-page
 * references) belongs to a separately reviewed lane.
 *
 * Invariants:
 *   - The actor id comes from the session boundary. No method accepts an owner,
 *     storage key, path, or filename.
 *   - Bytes are read through H-026's storage API, which re-verifies length and
 *     SHA-256. A tampered or missing object fails closed and writes no chunks.
 *   - Owner and conversation are enforced in SQL on every read and write.
 *     Foreign, unknown, malformed, pending, rejected, and tombstoned attachments
 *     all map to H-026's single non-enumerating `not_found`.
 *   - Re-extraction is transactional and idempotent: the previous chunk set is
 *     deleted and the deterministic new set inserted under the attachment lock.
 *   - Offsets are exact half-open UTF-16 spans into the normalized text; they
 *     are not byte offsets.
 *   - Extracted text is untrusted data. It is stored and returned as plain text,
 *     never evaluated, rendered as HTML, or used as an instruction or a
 *     capability.
 */
import type { Pool } from 'pg';
import { AttachmentService } from '../attachments/attachment-service.js';
import type { AttachmentContent, AttachmentStorage } from '../attachments/index.js';
import { PersistenceValidationError } from '../persistence/errors.js';
import { loadOwnedConversation } from '../persistence/rows.js';
import { ExtractionError } from './errors.js';
import { ExtractionRepository } from './extraction-repository.js';
import {
  buildCitationId,
  chunkText,
  readNormalizedDocument,
  validateCitationRange,
} from './text.js';
import type {
  ChunkSearchHit,
  Citation,
  CitationRange,
  ExtractedChunk,
  ExtractionSummary,
  ListChunksOptions,
  SearchChunksOptions,
  SupportedContentType,
} from './types.js';

/** Formats this lane actually extracts. PDF and images are intentionally absent. */
export const SUPPORTED_EXTRACTION_CONTENT_TYPES: readonly SupportedContentType[] = [
  'text/markdown',
  'text/plain',
];

const SUPPORTED_CONTENT_TYPES: ReadonlySet<string> = new Set(
  SUPPORTED_EXTRACTION_CONTENT_TYPES,
);

const MAX_SEARCH_TERM_LENGTH = 200;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

/**
 * Narrows a stored MIME essence to a supported format. Anything else — PDF,
 * images, or an unknown value written by a future lane — is refused before the
 * bytes are decoded, so a binary format is never passed to a text decoder.
 */
function requireSupportedContentType(contentType: string): SupportedContentType {
  if (
    !SUPPORTED_CONTENT_TYPES.has(contentType) ||
    (contentType !== 'text/markdown' && contentType !== 'text/plain')
  ) {
    throw new ExtractionError('unsupported_media_type');
  }

  return contentType;
}

function normalizeSearchTerm(query: string): string {
  if (typeof query !== 'string') {
    throw new PersistenceValidationError('invalid_input');
  }

  const term = query.trim();

  if (
    term.length === 0 ||
    Array.from(term).length > MAX_SEARCH_TERM_LENGTH ||
    hasControlCharacters(term)
  ) {
    throw new PersistenceValidationError('invalid_input');
  }

  return term;
}

export class ExtractionService {
  private readonly attachments: AttachmentService;
  private readonly repository: ExtractionRepository;
  private readonly pool: Pool;

  constructor(pool: Pool, storage: AttachmentStorage) {
    this.pool = pool;
    this.attachments = new AttachmentService(pool, storage);
    this.repository = new ExtractionRepository(pool);
  }

  /**
   * Reads one owned, stored attachment through H-026's verified storage path,
   * normalizes its text, and replaces its chunk set. Repeated calls over the
   * same bytes produce the same chunk count, offsets, and text.
   */
  async extract(
    actorUserId: string,
    attachmentId: string,
  ): Promise<ExtractionSummary> {
    const content = await this.attachments.readContent(actorUserId, attachmentId);
    const doc = this.prepare(content);

    const spans = chunkText(doc.text);

    // A normalized non-empty document always yields at least one span; this
    // guard keeps a future chunker change from persisting an empty extraction.
    if (spans.length === 0) {
      throw new ExtractionError('empty_content');
    }

    await this.repository.replace(
      actorUserId,
      doc.metadata.id,
      spans.map((span) => ({
        text: doc.text.slice(span.startOffset, span.endOffset),
        startOffset: span.startOffset,
        endOffset: span.endOffset,
      })),
    );

    return {
      attachmentId: doc.metadata.id,
      contentType: doc.contentType,
      characterCount: doc.text.length,
      chunkCount: spans.length,
    };
  }

  /**
   * Returns the exact passage at `range`, together with a stable citation id.
   * The range is validated after ownership and content type are proven, so a
   * foreign id cannot be probed with a malformed range. A citation requires a
   * current extraction; a document that was never extracted (or whose stored
   * coverage no longer spans the document) is `not_extracted`.
   */
  async cite(
    actorUserId: string,
    attachmentId: string,
    range: CitationRange,
  ): Promise<Citation> {
    const content = await this.attachments.readContent(actorUserId, attachmentId);
    const doc = this.prepare(content);
    const validated = validateCitationRange(range, doc.text.length);
    const aggregate = await this.repository.aggregate(actorUserId, doc.metadata.id);

    if (
      aggregate.chunkCount === 0 ||
      aggregate.startOffset !== 0 ||
      aggregate.endOffset !== doc.text.length
    ) {
      throw new ExtractionError('not_extracted');
    }

    const text = doc.text.slice(validated.startOffset, validated.endOffset);

    return {
      id: buildCitationId(
        doc.metadata.id,
        validated.startOffset,
        validated.endOffset,
        text,
      ),
      attachmentId: doc.metadata.id,
      startOffset: validated.startOffset,
      endOffset: validated.endOffset,
      text,
    };
  }

  /** Ordered chunks for one owned attachment, bounded by one page. */
  async listChunks(
    actorUserId: string,
    attachmentId: string,
    options: ListChunksOptions = {},
  ): Promise<ExtractedChunk[]> {
    return this.repository.list(actorUserId, attachmentId, options);
  }

  /**
   * Literal, owner- and conversation-scoped chunk search. The conversation must
   * belong to the actor; the term is bound as data and never becomes SQL.
   */
  async searchChunks(
    actorUserId: string,
    conversationId: string,
    query: string,
    options: SearchChunksOptions = {},
  ): Promise<ChunkSearchHit[]> {
    const conversation = await loadOwnedConversation(
      this.pool,
      actorUserId,
      conversationId,
    );
    const term = normalizeSearchTerm(query);
    const chunks = await this.repository.search(
      actorUserId,
      conversation.id,
      term,
      options,
    );

    return chunks.map((chunk) => ({
      ...chunk,
      citationId: buildCitationId(
        chunk.attachmentId,
        chunk.startOffset,
        chunk.endOffset,
        chunk.text,
      ),
    }));
  }

  /** Shared read path: verified bytes, supported type, bounded normalized text. */
  private prepare(content: AttachmentContent): {
    metadata: AttachmentContent['metadata'];
    contentType: SupportedContentType;
    text: string;
  } {
    const contentType = requireSupportedContentType(content.metadata.contentType);

    return {
      metadata: content.metadata,
      contentType,
      text: readNormalizedDocument(content.content),
    };
  }
}
