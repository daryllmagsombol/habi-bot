/**
 * H-031 skill state errors.
 *
 * Malformed input and non-enumerating denial keep using the shared persistence
 * errors (`PersistenceValidationError`, `PersistenceNotFoundError`). The shared
 * error vocabulary has no skill lifecycle or name-conflict code, and extending
 * it is outside this lane's file ownership, so those two owner-visible states
 * carry a local code instead.
 *
 * These errors are thrown only after ownership has been proven: a foreign or
 * guessed id is always the shared `not_found`, never one of these.
 */

export type SkillErrorCode =
  | 'skill_unavailable'
  | 'skill_name_conflict'
  | 'skill_version_conflict';

/**
 * The owner may see the skill, but the requested operation is refused:
 * archived/deleted skills are read-only, and an archived/deleted Bot cannot
 * receive an attachment.
 */
export class SkillUnavailableError extends Error {
  readonly code = 'skill_unavailable';

  constructor() {
    super('skill_unavailable');
    this.name = 'SkillUnavailableError';
  }
}

/** A live skill already uses this name in the target owner/Bot scope. */
export class SkillNameConflictError extends Error {
  readonly code = 'skill_name_conflict';

  constructor() {
    super('skill_name_conflict');
    this.name = 'SkillNameConflictError';
  }
}

/** A concurrent update claimed the same version number. */
export class SkillVersionConflictError extends Error {
  readonly code = 'skill_version_conflict';

  constructor() {
    super('skill_version_conflict');
    this.name = 'SkillVersionConflictError';
  }
}
