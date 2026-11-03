/**
 * H-031 (#31) skill vocabulary and public shapes.
 *
 * A Skill is versioned Markdown guidance owned by one user. `botId` is null for
 * an owner-level library entry and names the one Bot it is attached to
 * otherwise. Attachment is metadata only: it never changes Bot instructions or
 * grants a capability.
 *
 * Ownership columns never cross the service boundary.
 */

/** Migration 0014 lifecycle. `deleted` is a tombstone, not a hard delete. */
export type SkillStatus = 'draft' | 'active' | 'archived' | 'deleted';

/** Statuses a caller may request when creating a skill. */
export type CreatableSkillStatus = 'draft' | 'active';

/** A skill as exposed to its owner: the current version snapshot. */
export interface Skill {
  id: string;
  /** Null = owner-level library entry; otherwise the attached Bot. */
  botId: string | null;
  name: string;
  description: string;
  /** Untrusted Markdown guidance. Never parsed into permissions or executed. */
  bodyMarkdown: string;
  /** Current version number, matching one row in `skill_versions`. */
  version: number;
  status: SkillStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** One immutable snapshot from the version history. */
export interface SkillVersion {
  skillId: string;
  version: number;
  name: string;
  description: string;
  bodyMarkdown: string;
  createdAt: string;
}

/** One owner-scoped page of skills, newest updated first. */
export interface SkillPage {
  skills: Skill[];
  /** Opaque cursor for the next page, or null when exhausted. */
  nextCursor: string | null;
}

/** One owner-scoped page of version history, newest version first. */
export interface SkillVersionPage {
  versions: SkillVersion[];
  /** Pass as `beforeVersion` to fetch the next page, or null when exhausted. */
  nextBeforeVersion: number | null;
}

export interface CreateSkillInput {
  /** Trimmed server-side; 1-80 characters after trimming. */
  name: string;
  /** Defaults to `''`; at most 500 characters. */
  description?: string;
  /** Defaults to `''`; untrusted Markdown, at most 65,536 UTF-8 bytes. */
  bodyMarkdown?: string;
  /** Defaults to `null` (owner-level). Must be an active Bot owned by the actor. */
  botId?: string | null;
  /** Defaults to `draft`. `archived`/`deleted` are not creation states. */
  status?: CreatableSkillStatus;
}

/**
 * Patch semantics: `undefined` leaves a field unchanged; `null` clears
 * description or body to `''`. A non-empty patch always creates a new version.
 * Ownership, attachment, and lifecycle fields are never patchable.
 */
export interface UpdateSkillInput {
  name?: string;
  description?: string | null;
  bodyMarkdown?: string | null;
}

export interface ListSkillsOptions {
  /** Defaults to every non-deleted skill; an explicit `deleted` lists tombstones. */
  status?: SkillStatus;
  /** `undefined` = any attachment, `null` = unattached only, string = that Bot. */
  botId?: string | null;
  /** Page size, 1-100; defaults to 20. */
  limit?: number;
  /** Opaque cursor from a previous `SkillPage`. */
  cursor?: string;
}

export interface ListSkillVersionsOptions {
  /** Page size, 1-100; defaults to 20. */
  limit?: number;
  /** Return versions strictly older than this version number. */
  beforeVersion?: number;
}

/** Normalized, validated creation payload handed to the repository. */
export interface CreateSkillRecord {
  name: string;
  description: string;
  bodyMarkdown: string;
  botId: string | null;
  status: CreatableSkillStatus;
}

/** Normalized patch; only present keys are changed. */
export interface UpdateSkillRecord {
  name?: string;
  description?: string;
  bodyMarkdown?: string;
}

/** Normalized owner-scoped listing filters. */
export interface NormalizedListSkillsOptions {
  status: SkillStatus | null;
  /** `undefined` = any, `null` = unattached, string = one owned Bot. */
  botId: string | null | undefined;
  limit: number;
  cursor: SkillCursor | null;
}

/** Normalized version-history page request. */
export interface NormalizedListSkillVersionsOptions {
  limit: number;
  beforeVersion: number | null;
}

/** Opaque keyset cursor, decoded but not trusted as an access key. */
export interface SkillCursor {
  updatedAt: string;
  id: string;
}
