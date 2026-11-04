import type { ReactNode } from 'react';
import {
  ListRow,
  type ListRowDensity,
  type ListRowState,
  type ListRowTitleOverflow,
} from '../ui';
import type { ThreadListItem } from './types';

export interface ThreadRowProps {
  readonly item: ThreadListItem;
  readonly state?: ListRowState | undefined;
  readonly density?: ListRowDensity | undefined;
  readonly subtitle?: ReactNode;
  readonly trailing?: ReactNode;
  readonly titleOverflow?: ListRowTitleOverflow | undefined;
  /** Select in place; modified clicks still navigate. */
  readonly onSelect?: (() => void) | undefined;
}

/**
 * A thread as a navigation row: title on the left, time on the right (or a
 * caller-supplied trailing cluster), with a selected state that is also
 * `aria-current`.
 *
 * This is the thread-specific role; the generic row mechanics live in the
 * `ListRow` primitive, so the index and the side card cannot drift.
 */
export function ThreadRow({
  item,
  state = 'default',
  density = 'compact',
  subtitle,
  trailing,
  titleOverflow,
  onSelect,
}: Readonly<ThreadRowProps>) {
  return (
    <ListRow
      href={item.href}
      title={item.title}
      subtitle={subtitle}
      state={state}
      density={density}
      titleOverflow={titleOverflow}
      onSelect={onSelect}
      trailing={
        trailing ?? (
          <span className="u-figures pt-px text-2xs font-normal text-subtle">{item.time}</span>
        )
      }
    />
  );
}
