import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'signal' | 'success' | 'danger' | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-transparent bg-sunken text-muted',
  accent: 'border-transparent bg-accent-soft text-accent-ink',
  /* Evidence, not action: run state, citations, live marks. */
  signal: 'border-transparent bg-signal-soft text-signal-ink',
  success: 'border-transparent bg-success-soft text-success',
  danger: 'border-transparent bg-danger-soft text-danger-ink',
  outline: 'border-line bg-transparent text-subtle',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-subtle',
  accent: 'bg-accent',
  signal: 'bg-signal',
  success: 'bg-success',
  danger: 'bg-danger',
  outline: 'bg-subtle',
};

export interface BadgeProps {
  readonly tone?: BadgeTone;
  /** A leading status dot. Use for live or held state, not for every badge. */
  readonly dot?: boolean;
  /** Numerals in tabular widths (token counts, sequence numbers). */
  readonly figures?: boolean;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A compact state label: run status, memory verdict, counts.
 *
 * A pill, because state in this direction is soft and rounded; the text always
 * names the state, so colour is never the only signal.
 */
export function Badge({
  tone = 'neutral',
  dot = false,
  figures = false,
  className,
  children,
}: Readonly<BadgeProps>) {
  return (
    <span
      className={[
        'inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-2xs font-semibold whitespace-nowrap',
        figures ? 'u-figures' : '',
        TONES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? (
        <span aria-hidden="true" className={['size-1.5 rounded-full', DOT[tone]].join(' ')} />
      ) : null}
      {children}
    </span>
  );
}
