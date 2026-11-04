import type { ReactNode } from 'react';

export type CardTone = 'surface' | 'outline' | 'sunken';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

const TONES: Record<CardTone, string> = {
  surface: 'border-line bg-surface',
  outline: 'border-line bg-transparent',
  sunken: 'border-line bg-sunken',
};

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-4',
  md: 'p-5 sm:p-6',
  lg: 'p-6 sm:p-8',
};

export interface CardProps {
  readonly tone?: CardTone;
  readonly padding?: CardPadding;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A flat ruled surface. One hairline, near-square corners, no elevation — depth
 * is reserved for a surface that floats over another (the mobile sheet).
 */
export function Card({ tone = 'surface', padding = 'md', className, children }: Readonly<CardProps>) {
  return (
    <div
      className={['rounded-sm border', TONES[tone], PADDING[padding], className]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}

function titleIdFrom(title: string, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `${slug === '' ? 'panel' : slug}-title`;
}

export interface PanelProps {
  readonly title: string;
  readonly description?: ReactNode;
  /** Right-aligned controls in the heading row. */
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /** `label` is the uppercase micro-heading used inside evidence panels. */
  readonly headingStyle?: 'title' | 'label';
  /** Heading level. Pages keep a single `h1`; panels start at 2. */
  readonly headingLevel?: 2 | 3 | 4;
  /** Wrap the panel in its own ruled surface. */
  readonly surface?: boolean;
  readonly id?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A labelled section with a hairline under its heading.
 *
 * `aria-labelledby` points at the visible title, so the region is navigable by
 * heading and identifiable in a landmark list. The id derives from the title
 * when none is supplied, keeping markup deterministic on the server.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  headingStyle = 'title',
  headingLevel = 2,
  surface = false,
  id,
  className,
  children,
}: Readonly<PanelProps>) {
  const headingId = titleIdFrom(title, id);
  const Heading = headingLevel === 2 ? 'h2' : headingLevel === 3 ? 'h3' : 'h4';

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3 pb-2.5 border-b border-line">
        <Heading
          id={headingId}
          className={
            headingStyle === 'label'
              ? 'u-label text-subtle'
              : 'text-title tracking-heading'
          }
        >
          {title}
        </Heading>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {description === undefined ? null : (
        <div className="mt-3 text-sm leading-relaxed text-muted">{description}</div>
      )}

      {children === undefined ? null : <div className="mt-3">{children}</div>}

      {footer === undefined ? null : (
        <div className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
          {footer}
        </div>
      )}
    </>
  );

  if (surface) {
    return (
      <section aria-labelledby={headingId} className={className}>
        <Card padding="sm">{body}</Card>
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className={className}>
      {body}
    </section>
  );
}
