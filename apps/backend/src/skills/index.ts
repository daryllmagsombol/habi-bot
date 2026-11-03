/**
 * H-031 (#31) skills exports.
 *
 * Importing this barrel creates nothing and touches no database. `SkillService`
 * is constructed explicitly by the composing lane; no Nest provider or HTTP
 * route is added in this slice.
 */
export {
  SKILL_GUIDANCE_TRUST,
  SKILL_TOOL_GRANT_ALLOWLIST,
  describeSkillGuidance,
  type SkillGuidance,
} from './capability.js';
export { decodeSkillCursor, encodeSkillCursor } from './cursor.js';
export {
  SkillNameConflictError,
  SkillUnavailableError,
  SkillVersionConflictError,
  type SkillErrorCode,
} from './errors.js';
export { SkillRepository } from './skill-repository.js';
export { SkillService } from './skill-service.js';
export {
  DEFAULT_SKILL_PAGE_SIZE,
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_MIN_LENGTH,
  normalizeCreateSkillInput,
  normalizeListSkillVersionsOptions,
  normalizeListSkillsOptions,
  normalizeSkillBody,
  normalizeSkillDescription,
  normalizeSkillName,
  normalizeSkillVersionNumber,
  normalizeUpdateSkillInput,
} from './validation.js';
export type {
  CreatableSkillStatus,
  CreateSkillInput,
  CreateSkillRecord,
  ListSkillVersionsOptions,
  ListSkillsOptions,
  NormalizedListSkillsOptions,
  NormalizedListSkillVersionsOptions,
  Skill,
  SkillCursor,
  SkillPage,
  SkillStatus,
  SkillVersion,
  SkillVersionPage,
  UpdateSkillInput,
  UpdateSkillRecord,
} from './types.js';
