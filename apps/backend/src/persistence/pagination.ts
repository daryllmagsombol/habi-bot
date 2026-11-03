import { PersistenceValidationError } from './errors.js';

/** Page size used when the caller does not specify one. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Safety bound, not a product retention or quota limit. It stops a single
 * request from materializing an unbounded transcript page.
 */
export const MAX_PAGE_SIZE = 100;

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_PAGE_SIZE;
  }

  if (!Number.isInteger(limit) || limit < 1) {
    throw new PersistenceValidationError('invalid_input');
  }

  return Math.min(limit, MAX_PAGE_SIZE);
}
