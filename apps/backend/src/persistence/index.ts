export {
  createPersistencePool,
  withTransaction,
  type PersistencePoolOptions,
  type Queryable,
} from './database.js';
export { ConversationRepository } from './conversation-repository.js';
export { MessageRepository } from './message-repository.js';
export { ChatPersistenceService } from './chat-persistence.service.js';
export {
  isUniqueViolation,
  PersistenceConflictError,
  PersistenceError,
  PersistenceNotFoundError,
  PersistenceValidationError,
  uniqueViolationConstraint,
  type PersistenceErrorCode,
} from './errors.js';
export {
  decodeConversationCursor,
  decodeMessageCursor,
  encodeConversationCursor,
  encodeMessageCursor,
  isUuid,
  type ConversationCursor,
} from './cursor.js';
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, normalizeLimit } from './pagination.js';
export type {
  AppendMessageInput,
  CreateConversationInput,
  ListConversationsOptions,
  ListMessagesOptions,
} from './types.js';
