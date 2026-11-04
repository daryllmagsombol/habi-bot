'use client';

import Link from 'next/link';
import { LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { useId } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { DURATION, EASE } from '../../lib/motion';

export interface SegmentedItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  /** Marks the item as the current view. */
  readonly current?: boolean;
  /** A count or short state shown after the label. */
  readonly meta?: ReactNode;
}

export interface SegmentedProps {
  /** Accessible name for the group, e.g. "Thread panels". */
  readonly label: string;
  readonly items: readonly SegmentedItem[];
  /** Stretch to the container width, with each segment sharing it. */
  readonly block?: boolean;
  /**
   * When provided, the control updates in place and the URL is synced by the
   * caller, so the tint can move between segments instead of repainting.
   * Modified clicks and middle clicks still navigate normally.
   */
  readonly onSelect?: (key: string) => void;
  readonly className?: string;
}

/**
 * A segmented control built on navigation, not on ARIA tabs.
 *
 * Each segment is a real URL: the panel can be linked, opened in a new tab, and
 * survives a reload, and the browser's back button does what the reader expects.
 * The current view is exposed with `aria-current`, so it is announced without
 * any script.
 *
 * Every segment is at least 44px tall; labels wrap to the next segment rather
 * than shrinking the target.
 */
export function Segmented({
  label,
  items,
  block = false,
  onSelect,
  className,
}: Readonly<SegmentedProps>) {
  const layoutGroupId = useId();
  const reduceMotion = useReducedMotion();

  function handleClick(event: MouseEvent<HTMLAnchorElement>, key: string) {
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
    onSelect(key);
  }

  return (
    <nav
      aria-label={label}
      className={[
        'inline-flex max-w-full items-stretch rounded-sm border border-line bg-surface',
        block ? 'flex w-full' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <LayoutGroup id={layoutGroupId}>
        <ul
          className={['flex min-w-0 flex-wrap items-stretch', block ? 'w-full' : '']
            .filter(Boolean)
            .join(' ')}
        >
          {items.map((item) => (
            <li
              key={item.key}
              className={['relative min-w-0 border-r border-line last:border-r-0', block ? 'flex-1' : '']
                .filter(Boolean)
                .join(' ')}
            >
              {item.current === true ? (
                <motion.span
                  aria-hidden="true"
                  layoutId={`${layoutGroupId}-current`}
                  className="absolute inset-0 bg-accent-soft"
                  transition={
                    reduceMotion === true ? { duration: 0 } : { duration: DURATION.base, ease: EASE }
                  }
                />
              ) : null}

              <Link
                href={item.href}
                aria-current={item.current === true ? 'page' : undefined}
                onClick={(event) => handleClick(event, item.key)}
                className={[
                  'relative flex min-h-11 items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap',
                  block ? 'w-full justify-center' : '',
                  'transition-colors duration-[var(--habi-duration-fast)] ease-standard',
                  item.current === true
                    ? 'text-accent-ink'
                    : 'text-muted hover:bg-sunken hover:text-ink',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {item.label}
                {item.meta === undefined ? null : (
                  <span className="u-figures text-2xs text-subtle">{item.meta}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </LayoutGroup>
    </nav>
  );
}
