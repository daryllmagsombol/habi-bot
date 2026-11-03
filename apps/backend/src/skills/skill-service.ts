/**
 * H-031 SkillService: owner-scoped, versioned Markdown guidance.
 *
 * Invariants:
 *   - Every method takes the authenticated actor id from the session boundary.
 *     No method accepts an owner id from input.
 *   - Every read and write is owner-scoped; foreign, guessed, malformed, and
 *     tombstoned ids all fail closed with one non-enumerating not-found.
 *   - `update` always creates a new immutable version. Archived/deleted skills
 *     are read-only, and only a live draft/active skill can be attached or
 *     detached.
 *   - Attachment names an active owned Bot; it never modifies that Bot's
 *     instructions or capability.
 *   - A skill body is untrusted Markdown data. It cannot grant a tool, change
 *     backend policy, execute HTML/scripts, or trigger a fetch. The capability
 *     boundary is stated in `capability.ts` and the POC allow-list stays empty.
 *
 * HTTP routes, UI, run-level selection, prompt assembly, dry-run/model testing,
 * retention, export, and sharing are integration work owned elsewhere and are
 * not implemented here.
 */
import type { Pool } from 'pg';
import { SkillRepository } from './skill-repository.js';
import type {
  CreateSkillInput,
  ListSkillVersionsOptions,
  ListSkillsOptions,
  Skill,
  SkillPage,
  SkillVersion,
  SkillVersionPage,
  UpdateSkillInput,
} from './types.js';
import { normalizeSkillVersionNumber } from './validation.js';

export class SkillService {
  private readonly repository: SkillRepository;

  constructor(pool: Pool) {
    this.repository = new SkillRepository(pool);
  }

  /** Creates a draft (or explicitly active) skill with version 1. */
  create(actorUserId: string, input: CreateSkillInput): Promise<Skill> {
    return this.repository.create(actorUserId, input);
  }

  /** Applies a patch as a new immutable version. */
  update(
    actorUserId: string,
    skillId: string,
    input: UpdateSkillInput,
  ): Promise<Skill> {
    return this.repository.update(actorUserId, skillId, input);
  }

  /** Reads one live skill owned by the actor. Tombstones are not found. */
  get(actorUserId: string, skillId: string): Promise<Skill> {
    return this.repository.get(actorUserId, skillId);
  }

  /** Owner-scoped keyset listing, optionally filtered by status/attachment. */
  list(
    actorUserId: string,
    options: ListSkillsOptions = {},
  ): Promise<SkillPage> {
    return this.repository.list(actorUserId, options);
  }

  /** Archives a live skill. Repeat calls are idempotent; content is read-only. */
  archive(actorUserId: string, skillId: string): Promise<Skill> {
    return this.repository.archive(actorUserId, skillId);
  }

  /** Tombstones a skill. Repeat calls are idempotent and retain history. */
  delete(actorUserId: string, skillId: string): Promise<Skill> {
    return this.repository.delete(actorUserId, skillId);
  }

  /** Attaches a live skill to an active owned Bot. */
  attach(
    actorUserId: string,
    skillId: string,
    botId: string,
  ): Promise<Skill> {
    return this.repository.attach(actorUserId, skillId, botId);
  }

  /** Detaches a live skill from its Bot. */
  detach(actorUserId: string, skillId: string): Promise<Skill> {
    return this.repository.detach(actorUserId, skillId);
  }

  /** Owner-scoped immutable version history, newest version first. */
  listVersions(
    actorUserId: string,
    skillId: string,
    options: ListSkillVersionsOptions = {},
  ): Promise<SkillVersionPage> {
    return this.repository.listVersions(actorUserId, skillId, options);
  }

  /** Reads one exact skill version, so a run can pin `(skillId, version)`. */
  async getVersion(
    actorUserId: string,
    skillId: string,
    version: number,
  ): Promise<SkillVersion> {
    return this.repository.getVersion(
      actorUserId,
      skillId,
      normalizeSkillVersionNumber(version),
    );
  }
}
