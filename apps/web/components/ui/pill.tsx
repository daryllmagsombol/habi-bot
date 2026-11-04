import type { ReactNode } from 'react';

export type PillTone = 'surface' | 'sunken' | 'outline' | 'transparent';
export type PillSize = 'xs' | 'sm' | 'md';

const TONE: Record<PillTone, string> = {
  surface: 'bg-surface text-subtle',
  sunken: 'bg-sunken text-subtle',
  outline: 'border border-line bg-transparent text-subtle',
  transparent: 'text-subtle',
};

const SIZE: Record<PillSize, string> = {
  xs: 'min-h-5 gap-1.5 px-1.5 py-0.5 text-2xs',
  sm: 'min-h-6 gap-1.5 px-1.5 py-1.5 text-2xs',
  md: 'min-h-6 gap-2 px-2.5 py-1.5 text-2xs',
};

export interface PillProps {
  readonly tone?: PillTone;
  readonly size?: PillSize;
  readonly as?: 'span' | 'div' | 'p';
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A neutral rounded container: counts, the allowance, and other small chrome
 * facts. Unlike `Badge`, it carries no state tone — a Badge names a state, a
 * Pill groups a few inline bits.
 */
export function Pill({
  tone = 'sunken',
  size = 'md',
  as = 'span',
  className,
  children,
}: Readonly<PillProps>) {
  const Tag = as;

  return (
    <Tag
      className={[
        'inline-flex items-center rounded-full whitespace-nowrap text-subtle',
        TONE[tone],
        SIZE[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </Tag>
  );
}
