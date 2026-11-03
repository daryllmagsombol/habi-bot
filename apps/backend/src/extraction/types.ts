/**
 * H-027 (#27) extraction and citation vocabulary.
 *
 * Extracted text is untrusted data, never instructions:
 *   - No method consumes document text as a prompt, tool call, or capability.
 *   - The service stores and returns exact text slices; callers must render
 *     them as text (escaped where HTML is produced), never as HTML or code.
 *   - Chunk text is bounded by `CHUNK_CHARACTERS`, and a document is bounded by
 *     `MAX_EXTRACTED_CHARACTERS`.
 *
 * Offsets are half-open `[startOffset, endOffset)` UTF-16 code-unit indices
 * into the normalized document text (NFKC, LF-only line endings), which is the
 * same string JavaScript `slice` operates on. They are not byte offsets and do
 * not refer to the raw uploaded bytes.
 */

/** Formats this lane can extract without a new dependency. PDF is not one. */
export type SupportedContentType = 'text/markdown' | 'text/plain';

/** One deterministic chunk of the normalized document text. */
export interface ExtractedChunk {
  attachmentId: string;
  /** Zero-based position; the only ordering key. */
  chunkIndex: number;
  /** Exact `normalizedText.slice(startOffset, endOffset)`. */
  text: string;
  startOffset: number;
  endOffset: number;
}

/** Metadata returned by `extract`; the full text stays in chunk storage. */
export interface ExtractionSummary {
  attachmentId: string;
  contentType: SupportedContentType;
  /** Length of the normalized document text in UTF-16 code units. */
  characterCount: number;
  chunkCount: number;
}

/** Half-open range in normalized document text. */
export interface CitationRange {
  startOffset: number;
  endOffset: number;
}

/**
 * One passage reference. `id` is stable for the same attachment, offsets, and
 * exact quote, so repeated citations of one passage compare equal.
 */
export interface Citation extends CitationRange {
  id: string;
  attachmentId: string;
  /** Exact `normalizedText.slice(startOffset, endOffset)`. Untrusted data. */
  text: string;
}

export interface ListChunksOptions {
  /** Defaults to `MAX_PAGE_SIZE`; bounded by the same value. */
  limit?: number;
  /** Return chunks with a larger `chunkIndex`. */
  afterChunkIndex?: number;
}

export interface SearchChunksOptions {
  limit?: number;
}

/** Owner- and conversation-scoped chunk search hit. */
export interface ChunkSearchHit extends ExtractedChunk {
  /** Stable citation id for the whole chunk. */
  citationId: string;
}
