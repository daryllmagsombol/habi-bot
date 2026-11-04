import type { ReactNode } from 'react';

export interface SectionHeaderProps {
  readonly label: ReactNode;
  /** Shown after a middot, e.g. the count in "Threads · 3". */
  readonly count?: ReactNode;
  /** A trailing control, e.g. an edit affordance. */
  readonly action?: ReactNode;
  readonly as?: 'h2' | 'h3' | 'h4';
  readonly id?: string;
  readonly className?: string;
}

/**
 * The micro-heading above a card's content: uppercase label, optional count,
 * optional trailing action. One component so every card labels itself the same
 * way and the heading level stays under the page's `h1`.
 */
export function SectionHeader({
  label,
  count,
  action,
  as = 'h2',
  id,
  className,
}: Readonly<SectionHeaderProps>) {
  const Heading = as;

  const heading = (
    <Heading id={id} className={['u-label text-subtle', className].filter(Boolean).join(' ')}>
      {label}
      {count === undefined ? null : (
        <>
          {' · '}
          <span className="u-figures">{count}</span>
        </>
      )}
    </Heading>
  );

  if (action === undefined) {
    return heading;
  }

  return (
    <div className="flex items-center justify-between gap-3">
      {heading}
      <div className="shrink-0">{action}</div>
    </div>
  );
}
