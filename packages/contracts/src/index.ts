/**
 * Minimal service health contract shared by Habi's API and future clients.
 * This is type-only by design: the runtime module intentionally has no values.
 */
export interface HealthResponse {
  status: 'ok';
  service: 'api';
}
