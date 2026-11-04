/**
 * Derived list projections for the Bot chooser.
 *
 * Nothing here is a new persisted field or a new policy. A `purpose` fragment is
 * display text taken from the owner's own Bot description (falling back to the
 * first non-blank instruction line) and collapsed to one bounded line. Bot
 * instructions remain untrusted data: this module never parses Markdown into
 * behaviour, capability, or UI.
 */
import type { BotProfile, BotStatus } from '../bots/types.js';

export const PURPOSE_FRAGMENT_MAX_LENGTH = 140;

function firstNonBlankLine(value: string): string {
  for (const line of value.split(/\r?\n/)) {
    if (line.trim().length > 0) {
      return line;
    }
  }

  return '';
}

export function purposeFragment(bot: BotProfile): string {
  const source = bot.description.trim() || firstNonBlankLine(bot.instructionsMarkdown);
  const collapsed = source.replaceAll(/\s+/g, ' ').trim();

  return Array.from(collapsed).slice(0, PURPOSE_FRAGMENT_MAX_LENGTH).join('');
}

export interface BotSummary {
  id: string;
  name: string;
  /** One bounded display line; untrusted text, never executable UI. */
  purpose: string;
  status: BotStatus;
  avatarRef: string | null;
  conversationCount: number;
  /** Latest conversation activity, or the Bot's own update when it has none. */
  lastActivityAt: string;
  updatedAt: string;
}

export interface BotDetail {
  bot: BotProfile;
  purpose: string;
  conversationCount: number;
  lastActivityAt: string;
}
