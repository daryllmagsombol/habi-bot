/**
 * H-027 (#27) extraction exports.
 *
 * Importing this barrel creates nothing and touches no database, storage, or
 * network. `ExtractionService` is constructed explicitly by the composing lane
 * with a `Pool` and an H-026 `AttachmentStorage`. There is no HTTP route, Nest
 * provider, worker process, OCR, PDF reader, or external service in this slice.
 */
export { ExtractionError } from './errors.js';
export type { ExtractionErrorCode } from './errors.js';
export {
  ExtractionRepository,
  type ChunkAggregate,
  type ChunkInsert,
} from './extraction-repository.js';
export {
  ExtractionService,
  SUPPORTED_EXTRACTION_CONTENT_TYPES,
} from './extraction-service.js';
export {
  buildCitationId,
  CHUNK_CHARACTERS,
  CHUNK_OVERLAP_CHARACTERS,
  chunkText,
  decodeExtractedText,
  MAX_CITATION_CHARACTERS,
  MAX_EXTRACTED_CHARACTERS,
  normalizeExtractedText,
  readNormalizedDocument,
  validateCitationRange,
} from './text.js';
export type {
  ChunkSearchHit,
  Citation,
  CitationRange,
  ExtractedChunk,
  ExtractionSummary,
  ListChunksOptions,
  SearchChunksOptions,
  SupportedContentType,
} from './types.js';
