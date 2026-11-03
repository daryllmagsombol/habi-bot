/**
 * Artifact-specific failures.
 *
 * Ownership, unknown ids, malformed ids, and tombstoned artifacts all reuse
 * `PersistenceNotFoundError`, so there is exactly one non-enumerating
 * not-found outcome across the service. Malformed content, titles, kinds,
 * statuses, and version numbers reuse `PersistenceValidationError`.
 */

/**
 * The stored version body does not match the metadata recorded with it. The
 * owner was already proven, so this is an integrity failure, not an existence
 * signal. It fails closed and never returns the unverified text.
 */
export class ArtifactIntegrityError extends Error {
  readonly code = 'artifact_integrity' as const;

  constructor() {
    super('artifact_integrity');
    this.name = 'ArtifactIntegrityError';
  }
}
