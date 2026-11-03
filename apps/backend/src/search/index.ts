/**
 * H-029 (#29) search exports.
 *
 * Importing this barrel creates nothing and opens no connection; both services
 * are constructed explicitly with an existing pool. There is no Nest provider,
 * cache, or HTTP route in this slice.
 */
export { ConversationSearchService } from './conversation-search-service.js';
export { SearchService } from './search-service.js';
export {
  SNIPPET_HIT_END,
  SNIPPET_HIT_START,
  escapeHtml,
  toSnippet,
} from './snippet.js';
export {
  assertConversationCursorScope,
  assertMessageCursorScope,
  assertSearchableQuery,
  decodeConversationSearchCursor,
  decodeMessageSearchCursor,
  encodeConversationSearchCursor,
  encodeMessageSearchCursor,
  normalizeScopeId,
  normalizeSearchLimit,
  normalizeSearchQuery,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_QUERY_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
  type ConversationSearchCursor,
  type MessageSearchCursor,
  type NormalizedSearchQuery,
} from './validation.js';
export type {
  ConversationSearchHit,
  ConversationSearchPage,
  MessageSearchHit,
  MessageSearchPage,
  SearchConversationsInput,
  SearchMessagesInput,
} from './types.js';
