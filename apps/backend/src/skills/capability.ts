/**
 * H-031 capability boundary.
 *
 * A skill body is untrusted Markdown guidance. This module exists so the
 * boundary is explicit and testable instead of implied:
 *
 *   - A skill never grants a tool. `SKILL_TOOL_GRANT_ALLOWLIST` is frozen and
 *     empty, matching the H-006 POC policy `platform_toolsets.api_server: []`.
 *   - This module does not parse tool declarations, MCP configuration, URLs,
 *     HTML, or commands out of a body. There is no HTML execution, no DOM, no
 *     outbound fetch, and no shell/browser/provider call anywhere in `skills/`.
 *   - `describeSkillGuidance` is pure. It returns the stored text plus an
 *     `untrusted` marker and the empty grant list; callers that build a prompt
 *     must treat the text as data and keep backend policy authoritative.
 *   - Attaching a skill to a Bot records `bot_id` only. It does not append to
 *     Bot instructions, change `bot_capabilities`, or alter effective
 *     capability.
 *
 * The issue's manual-selection/test-mode work is runtime integration (runs,
 * provider adapters, HTTP/UI) and is not implemented or claimed here. A run
 * that later pins guidance can record `(skillId, version)` from
 * `SkillService.listVersions`/`getVersion`; the version rows are immutable.
 */
import type { Skill } from './types.js';

/** The only tool list a skill can contribute. Always empty by construction. */
export const SKILL_TOOL_GRANT_ALLOWLIST: readonly string[] = Object.freeze([]);

/** Trust marker for skill text. It can never be `trusted`. */
export const SKILL_GUIDANCE_TRUST = 'untrusted' as const;

/** Plain, inert description of the guidance a skill contributes. */
export interface SkillGuidance {
  skillId: string;
  version: number;
  trust: typeof SKILL_GUIDANCE_TRUST;
  /** Frozen empty list: Markdown never grants capability. */
  grantsTools: readonly string[];
  /** Stored body verbatim. Data only; never executed or parsed for policy. */
  text: string;
}

/**
 * Returns the stored body and the empty capability surface. This is a pure
 * projection with no side effects, so calling it can never execute Markdown,
 * fetch a URL, or grant a tool.
 */
export function describeSkillGuidance(skill: Skill): SkillGuidance {
  return {
    skillId: skill.id,
    version: skill.version,
    trust: SKILL_GUIDANCE_TRUST,
    grantsTools: SKILL_TOOL_GRANT_ALLOWLIST,
    text: skill.bodyMarkdown,
  };
}
