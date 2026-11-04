import type { AvatarTone } from '../ui';

/*
 * Bot identity is presentation, not data: the sample record carries a name and
 * initials, and this map decides which wash the avatar uses. A real Bot without
 * an entry falls back to the neutral avatar instead of a wrong colour.
 */
const TONE: Readonly<Record<string, AvatarTone>> = {
  'field-notes': 'iris',
  'draft-partner': 'sage',
  'sounding-board': 'apricot',
  'second-reader': 'plum',
};

export function botTone(botId: string): AvatarTone {
  return TONE[botId] ?? 'neutral';
}
