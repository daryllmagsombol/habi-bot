/**
 * Asia/Manila calendar-day helpers for the H-023 allowance.
 *
 * The allowance day is the calendar day in Asia/Manila (UTC+8, no daylight
 * saving since 1978), and it resets at 00:00:00 local time, which is 16:00:00
 * UTC on the previous calendar date. The day is computed with
 * `Intl.DateTimeFormat` so no new dependency, timezone database package, or
 * PostgreSQL extension is required.
 *
 * The clock is never read here. Callers pass the instant, which keeps the
 * boundary testable and keeps the service compatible with an injected clock.
 */

export const MANILA_TIME_ZONE = 'Asia/Manila';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MANILA_DATE = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MANILA_DATE_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: MANILA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface CalendarParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface ClockParts extends CalendarParts {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function readParts(format: Intl.DateTimeFormat, at: Date): ClockParts {
  const parts = format.formatToParts(at);
  const values = new Map<string, number>();

  for (const part of parts) {
    if (part.type !== 'literal') {
      values.set(part.type, Number(part.value));
    }
  }

  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = values.get('hour') ?? 0;
  const minute = values.get('minute') ?? 0;
  const second = values.get('second') ?? 0;

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new TypeError('Unable to format an instant in Asia/Manila.');
  }

  return { year, month, day, hour, minute, second };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function assertValidInstant(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('A valid Date is required to resolve an allowance day.');
  }
}

/**
 * Offset of Asia/Manila at `at`, in milliseconds east of UTC. Computed from the
 * formatted local wall-clock time instead of a hardcoded `+08:00`, so a future
 * offset change is picked up without touching this module.
 */
function manilaOffsetMs(at: Date): number {
  const parts = readParts(MANILA_DATE_TIME, at);
  const wholeSecond = Math.floor(at.getTime() / 1000) * 1000;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - wholeSecond;
}

/** Plain `YYYY-MM-DD` calendar day for `at` in Asia/Manila. */
export function manilaDayBucket(at: Date): string {
  assertValidInstant(at);
  const parts = readParts(MANILA_DATE, at);

  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** True for a syntactically and calendrically valid `YYYY-MM-DD` day bucket. */
export function isDayBucket(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    return false;
  }

  const parts = dayParts(value);

  return (
    Number.isFinite(parts.year) &&
    parts.month >= 1 &&
    parts.month <= 12 &&
    parts.day >= 1 &&
    parts.day <= 31 &&
    manilaDayBucket(manilaDayStart(value)) === value
  );
}

function dayParts(dayBucket: string): CalendarParts {
  const [year, month, day] = dayBucket.split('-').map(Number);

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new TypeError('A day bucket must be a YYYY-MM-DD string.');
  }

  return { year, month, day };
}

/**
 * First instant of the given Asia/Manila day, as a UTC `Date`. The offset is
 * evaluated twice so the result stays correct even if a zone ever gains a
 * transition near midnight.
 */
export function manilaDayStart(dayBucket: string): Date {
  const { year, month, day } = dayParts(dayBucket);
  const utcMidnight = Date.UTC(year, month - 1, day);
  let candidate = new Date(utcMidnight - manilaOffsetMs(new Date(utcMidnight)));
  candidate = new Date(utcMidnight - manilaOffsetMs(candidate));

  return candidate;
}

/** Shifts a day bucket by a whole number of calendar days. */
export function shiftDayBucket(dayBucket: string, days: number): string {
  const { year, month, day } = dayParts(dayBucket);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));

  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )}`;
}

/**
 * First instant after the allowance day, in UTC. A request refused today is
 * admissible again at this instant, not one sliding window later.
 */
export function nextManilaDayStart(at: Date): Date {
  return manilaDayStart(shiftDayBucket(manilaDayBucket(at), 1));
}
