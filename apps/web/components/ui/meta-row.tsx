import { Fragment } from 'react';
import type { ReactNode } from 'react';

export type MetaRowVariant = 'dotted' | 'spaced';

export interface MetaItem {
  /** Stable key; falls back to the item position. */
  readonly key?: string;
  readonly label: ReactNode;
  /** A small decorative mark before the label, e.g. a document glyph. */
  readonly icon?: ReactNode;
  /** Extra classes for this item, e.g. a right-aligned time column. */
  readonly className?: string;
}

export interface MetaRowProps {
  readonly items: readonly MetaItem[];
  /** `dotted` joins facts with `·`; `spaced` leaves them as bare columns. */
  readonly variant?: MetaRowVariant;
  readonly as?: 'p' | 'div' | 'span';
  readonly className?: string;
}

/**
 * A row of small facts — a timestamp, an attachment count, a token count.
 *
 * The separator is decorative (hidden from assistive tech); the facts read as
 * separate phrases. `spaced` is for a card foot where a live pill or an action
 * already sits in the same row.
 *
 * A fact with no icon or extra class renders as plain inline text, so a meta
 * row lines up exactly like the sentence it replaces. Icons and aligned columns
 * opt into an inline-flex item.
 */
export function MetaRow({
  items,
  variant = 'dotted',
  as = 'p',
  className,
}: Readonly<MetaRowProps>) {
  const Tag = as;

  return (
    <Tag
      className={[
        'flex flex-wrap items-center gap-y-1 text-2xs',
        variant === 'dotted' ? 'gap-x-2' : 'gap-x-3.5',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {items.map((item, index) => {
        const flexible = item.icon !== undefined || item.className !== undefined;
        const classes = [
          flexible ? 'inline-flex items-center gap-1' : '',
          'whitespace-nowrap',
          item.className,
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <Fragment key={item.key ?? index}>
            {variant === 'dotted' && index > 0 ? (
              <span aria-hidden="true" className="text-subtle">
                ·
              </span>
            ) : null}
            <span className={classes}>
              {item.icon === undefined ? null : (
                <span aria-hidden="true" className="opacity-70">
                  {item.icon}
                </span>
              )}
              {item.label}
            </span>
          </Fragment>
        );
      })}
    </Tag>
  );
}
