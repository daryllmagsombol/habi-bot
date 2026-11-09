/**
 * P1 chat surface exports. Importing this barrel creates nothing and opens no
 * database connection; the flag gate lives in `AppModule`.
 */
export { isP1ApiEnabled, P1_API_FLAG } from './api-config.js';
export { ApiError, ApiErrorFilter, type ApiErrorCode } from './api-errors.js';
export { P1ApiModule } from './api.module.js';
export { ApiRuntime } from './api-runtime.js';
export { ApiService } from './api-service.js';
export type {
  BotListPage,
  MemoryListPage,
  PostMessageResult,
  SearchResultPage,
} from './api-service.js';
export type { BotDetail, BotSummary } from './api-projection.js';
export type {
  BotThreadPage,
  ConversationActivity,
  ListBotThreadsOptions,
} from './api-repository.js';
