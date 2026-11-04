import type { ReactNode } from 'react';

export interface EmptyStateProps {
  /** A short, plain statement of what is missing. */
  readonly title: string;
  /** What to do about it, and what the empty state honestly means. */
  readonly description?: ReactNode;
  /** One primary action, usually a link. */
  readonly action?: ReactNode;
  /** Decorative mark, drawn as a 1.5px stroke icon. Sits in the text flow. */
  readonly mark?: ReactNode;
  /** `inline` is a full-width row, e.g. a create affordance under a gallery grid. */
  readonly layout?: 'stack' | 'inline';
  /** Keeps the page outline valid. Panels under an `h1` usually want `2`. */
  readonly headingLevel?: 2 | 3;
  readonly className?: string;
}

/**
 * An empty region that explains itself.
 *
 * Left-aligned and ruled, so it belongs to the same ledger as the content it
 * replaces. The mark sits in the text flow rather than in a tile above the
 * heading: a bordered icon square over a title is the generic feature-card
 * shape and says nothing the wording does not.
 *
 * No illustration, no apology, no "coming soon": a title, the reason, and the
 * one action that changes the state.
 */
export function EmptyState({
  title,
  description,
  action,
  mark,
  layout = 'stack',
  headingLevel = 3,
  className,
}: Readonly<EmptyStateProps>) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const inline = layout === 'inline';

  return (
    <div
      className={[
        'rounded-sm border border-dashed border-line-strong bg-surface',
        inline
          ? 'flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:gap-5'
          : 'flex flex-col items-start gap-4 px-5 py-7',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {mark === undefined ? null : (
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-subtle">
            {mark}
          </span>
        )}

        <div className="flex min-w-0 flex-col gap-1.5">
          <Heading
            className={inline ? 'text-base leading-snug font-semibold text-ink' : 'text-title tracking-heading text-ink'}
          >
            {title}
          </Heading>
          {description === undefined ? null : (
            <p className="max-w-[52ch] text-sm leading-relaxed text-muted">{description}</p>
          )}
        </div>
      </div>

      {action === undefined ? null : (
        <div className={inline ? 'shrink-0 pl-7 sm:pl-0' : 'flex flex-wrap gap-3 pl-7'}>
          {action}
        </div>
      )}
    </div>
  );
}
