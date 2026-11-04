import Link from 'next/link';
import type { MouseEvent, ReactNode } from 'react';

export type ListRowState = 'default' | 'selected';
export type ListRowDensity = 'compact' | 'comfortable';
export type ListRowTitleOverflow = 'wrap' | 'truncate';

export interface ListRowProps {
  readonly href: string;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** The right-hand column: a time, a count, a small cluster. */
  readonly trailing?: ReactNode;
  readonly state?: ListRowState;
  readonly density?: ListRowDensity;
  readonly titleOverflow?: ListRowTitleOverflow | undefined;
  /**
   * Select in place. Modified clicks and middle clicks still navigate; the
   * href is always real.
   */
  readonly onSelect?: (() => void) | undefined;
  readonly className?: string | undefined;
}

function handleClick(event: MouseEvent<HTMLAnchorElement>, onSelect?: () => void): void {
  if (onSelect === undefined) {
    return;
  }

  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  event.preventDefault();
  onSelect();
}

/**
 * A navigation row: title (and optional subtitle) on the left, trailing fact on
 * the right, with a selected state that is also `aria-current`.
 *
 * It is a link, not a button, so the list works without script, opens in a new
 * tab, and survives a reload. The caller owns the surrounding `<ul>`/`<li>` and
 * the divider.
 */
export function ListRow({
  href,
  title,
  subtitle,
  trailing,
  state = 'default',
  density = 'compact',
  titleOverflow = 'wrap',
  onSelect,
  className,
}: Readonly<ListRowProps>) {
  const selected = state === 'selected';

  return (
    <Link
      href={href}
      aria-current={selected ? 'page' : undefined}
      {...(onSelect === undefined
        ? {}
        : { onClick: (event: MouseEvent<HTMLAnchorElement>) => handleClick(event, onSelect) })}
      className={[
        'flex min-h-11 rounded-sm transition-colors',
        'duration-[var(--habi-duration-fast)] ease-standard',
        density === 'compact'
          ? 'items-start gap-2 px-2 py-1.5 text-xs leading-snug'
          : 'min-h-16 items-center gap-3 px-1 py-3 text-sm',
        selected ? 'bg-sunken font-semibold text-ink' : 'text-subtle hover:bg-sunken/60 hover:text-ink',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={[
            density === 'comfortable' ? 'font-semibold tracking-heading text-ink' : '',
            titleOverflow === 'truncate' ? 'truncate' : 'min-w-0',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {title}
        </span>
        {subtitle === undefined ? null : (
          <span className="text-2xs font-normal text-subtle">{subtitle}</span>
        )}
      </span>
      {trailing === undefined ? null : trailing}
    </Link>
  );
}
