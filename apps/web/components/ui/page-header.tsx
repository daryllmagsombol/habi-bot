import type { ReactNode } from 'react';

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Actions that sit under the description on narrow screens, beside it on wide ones. */
  readonly actions?: ReactNode;
  /** `display` is the landing statement; `page` is every other page title. */
  readonly size?: 'display' | 'page';
  readonly titleId?: string;
  readonly className?: string;
}

/**
 * The single `h1` for a page, plus its supporting copy.
 *
 * No eyebrow above the title: a small label that repeats what the heading says
 * adds a step without adding information. The description carries the context.
 * Panels below start at `h2`, so the outline never skips a level.
 */
export function PageHeader({
  title,
  description,
  actions,
  size = 'page',
  titleId,
  className,
}: Readonly<PageHeaderProps>) {
  return (
    <header className={className}>
      <h1
        id={titleId}
        className={
          size === 'display'
            ? 'max-w-[13ch] text-display tracking-display'
            : 'max-w-[24ch] text-page tracking-heading'
        }
      >
        {title}
      </h1>

      {description === undefined ? null : (
        <div
          className={
            size === 'display'
              ? 'mt-6 max-w-[48ch] text-lead text-muted'
              : 'mt-4 max-w-[58ch] text-base text-muted'
          }
        >
          {description}
        </div>
      )}

      {actions === undefined ? null : (
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          {actions}
        </div>
      )}
    </header>
  );
}
