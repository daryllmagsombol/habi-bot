/**
 * H-030 (#30) memory exports.
 *
 * Importing this barrel creates nothing and touches no database. `MemoryService`
 * is constructed explicitly by the composing lane; no Nest provider or HTTP
 * route is added in this slice.
 */
export { MemoryRepository } from './memory-repository.js';
export { MemoryService } from './memory-service.js';
export {
  DEFAULT_MEMORY_PAGE_SIZE,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_CONTENT_MIN_LENGTH,
  normalizeApprovalFlag,
  normalizeListMemoriesOptions,
  normalizeMemoryContent,
  normalizeProposeMemoryInput,
  normalizeRecallMemoriesOptions,
  normalizeSourceDeletedInput,
  type NormalizedListMemoriesOptions,
} from './validation.js';
export type {
  ListMemoriesOptions,
  Memory,
  MemoryAuditAction,
  MemoryAuditEntry,
  MemoryProvenanceState,
  MemoryRecord,
  MemoryStatus,
  ProposeMemoryInput,
  ProposeMemoryRecord,
  RecallMemoriesOptions,
  SourceDeletedInput,
  SourceDeletionResult,
} from './types.js';
