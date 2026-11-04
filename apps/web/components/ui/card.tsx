import type { ReactNode } from 'react';

export type CardVariant = 'surface' | 'dashed';
export type CardRadius = 'md' | 'lg' | 'xl';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg' | 'card';
export type CardElevation = 'none' | 'card' | 'lift';

const VARIANT: Record<CardVariant, string> = {
  surface: 'border border-line bg-surface',
  dashed: 'border border-dashed border-line-strong bg-transparent',
};

const RADIUS: Record<CardRadius, string> = {
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
};

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-6 sm:p-8',
  card: 'p-card sm:p-5',
};

const ELEVATION: Record<CardElevation, string> = {
  none: '',
  card: 'shadow-card',
  lift: 'shadow-lift',
};

export interface CardStyleOptions {
  readonly variant?: CardVariant | undefined;
  readonly radius?: CardRadius | undefined;
  readonly padding?: CardPadding | undefined;
  readonly elevation?: CardElevation | undefined;
  readonly className?: string | undefined;
}

/**
 * The card surface, as a string, for elements that cannot be a `<div>` — a link,
 * an aside, a fixed panel. The same hairline, radius and elevation tokens as
 * `<Card>`, so a card is never restyled by hand.
 */
export function cardStyles({
  variant = 'surface',
  radius = 'lg',
  padding = 'none',
  elevation = 'card',
  className,
}: Readonly<CardStyleOptions> = {}): string {
  return [VARIANT[variant], RADIUS[radius], PADDING[padding], ELEVATION[elevation], className]
    .filter(Boolean)
    .join(' ');
}

export interface CardProps {
  readonly as?: 'div' | 'section' | 'article' | 'aside';
  readonly variant?: CardVariant | undefined;
  readonly radius?: CardRadius | undefined;
  readonly padding?: CardPadding | undefined;
  readonly elevation?: CardElevation | undefined;
  readonly id?: string | undefined;
  readonly 'aria-labelledby'?: string | undefined;
  readonly 'aria-label'?: string | undefined;
  readonly className?: string | undefined;
  readonly children?: ReactNode;
}

/**
 * A surface on the page: white paper, one hairline, a soft elevation on the
 * ivory field. In dark the elevation token resolves to `none`, so the hairline
 * does the work instead of a shadow.
 */
export function Card({
  as = 'div',
  variant,
  radius,
  padding,
  elevation,
  id,
  className,
  children,
  ...aria
}: Readonly<CardProps>) {
  const Tag = as;

  return (
    <Tag
      id={id}
      aria-labelledby={aria['aria-labelledby']}
      aria-label={aria['aria-label']}
      className={cardStyles({ variant, radius, padding, elevation, className })}
    >
      {children}
    </Tag>
  );
}
