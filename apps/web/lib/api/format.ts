/**
 * Display formatting shared by the three data-backed screens.
 *
 * These helpers take wire values and return strings; they contain no business
 * rule. The API does not report token counts per conversation, daily allowance,
 * or memory records, so none of those are invented here.
 */

const CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'long' });
const WEEKDAY_SHORT = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

/** `14:02` in the reader's time zone. */
export function formatClock(iso: string): string {
  const value = new Date(iso);

  return Number.isNaN(value.getTime()) ? '—' : CLOCK.format(value);
}

/** `Today, 14:02`, `Yesterday, 09:05`, or `Monday, 16:20`. */
export function formatWhen(iso: string): string {
  const value = new Date(iso);

  if (Number.isNaN(value.getTime())) {
    return '—';
  }

  const today = startOfDay(new Date());
  const day = startOfDay(value);
  const difference = Math.round((today - day) / 86_400_000);

  if (difference === 0) {
    return `Today, ${CLOCK.format(value)}`;
  }

  if (difference === 1) {
    return `Yesterday, ${CLOCK.format(value)}`;
  }

  return `${WEEKDAY.format(value)}, ${CLOCK.format(value)}`;
}

/** `14:02` for today and yesterday, otherwise `Mon`. */
export function shortWhen(iso: string): string {
  const value = new Date(iso);

  if (Number.isNaN(value.getTime())) {
    return '—';
  }

  const difference = Math.round((startOfDay(new Date()) - startOfDay(value)) / 86_400_000);

  return difference === 0 || difference === 1
    ? CLOCK.format(value)
    : WEEKDAY_SHORT.format(value);
}

/** One or two initials from a Bot name. Never a colour or an authorization key. */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .slice(0, 2);

  if (words.length === 0) {
    return '?';
  }

  return words.map((word) => Array.from(word)[0] ?? '').join('').toUpperCase();
}

/** Blank-line separated paragraphs; a single newline stays inside one. */
export function paragraphsOf(content: string): readonly string[] {
  const paragraphs = content
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return paragraphs.length === 0 ? [''] : paragraphs;
}

export function countLabel(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

/** A compact byte size. The API reports bytes; the panel shows a readable unit. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
