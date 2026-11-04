import type { ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'signal' | 'success' | 'danger' | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-sunken text-muted',
  accent: 'border-accent-line bg-accent-soft text-accent-ink',
  /* Evidence, not action: run state, citations, live marks. */
  signal: 'border-signal-line bg-signal-soft text-signal-ink',
  success: 'border-success-line bg-success-soft text-success',
  danger: 'border-danger-line bg-danger-soft text-danger-ink',
  outline: 'border-line-strong bg-transparent text-muted',
};

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-ink-subtle',
  accent: 'bg-accent',
  signal: 'bg-signal',
  success: 'bg-success',
  danger: 'bg-danger',
  outline: 'bg-ink-muted',
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
 * Square rather than pill-shaped — the direction is a ruled ledger, and a pill
 * would read as a different system. Colour is never the only signal: the text
 * always names the state, and the dot only reinforces it.
 */
export function Badge({ tone = 'neutral', dot = false, figures = false, className, children }: Readonly<BadgeProps>) {
  return (
    <span
      className={[
        'inline-flex min-h-6 items-center gap-1.5 rounded-xs border px-1.5 py-0.5',
        'text-2xs font-semibold whitespace-nowrap',
        figures ? 'u-figures' : '',
        TONES[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dot ? <span aria-hidden="true" className={['size-1.5 rounded-full', DOT[tone]].join(' ')} /> : null}
      {children}
    </span>
  );
}
