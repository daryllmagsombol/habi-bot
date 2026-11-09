import type { ReactNode } from 'react';
import { Card, SectionHeader } from '../ui';
import { ThreadRow } from './thread-row';
import type { ThreadListItem } from './types';

export interface ThreadListCardProps {
  readonly label: string;
  readonly items: readonly ThreadListItem[];
  /** Id of the thread currently open; also marks the row with `aria-current`. */
  readonly activeId?: string | undefined;
  readonly onSelect?: ((id: string) => void) | undefined;
  readonly headingId: string;
  readonly emptyMessage: ReactNode;
  /** Section-header affordance, typically the new-thread control. */
  readonly actions?: ReactNode;
  /** Controls under the list, typically rename/create forms. */
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * The Bot's threads as a card: a micro-label with a count, then title/time rows.
 *
 * The open row is tinted and carries `aria-current`; selection is in place, but
 * every row is a real link so a new tab or a reload lands on the same thread.
 */
export function ThreadListCard({
  label,
  items,
  activeId,
  onSelect,
  headingId,
  emptyMessage,
  actions,
  footer,
  className,
}: Readonly<ThreadListCardProps>) {
  return (
    <Card as="section" radius="lg" padding="sm" aria-labelledby={headingId} className={className}>
      <SectionHeader as="h2" id={headingId} label={label} count={items.length} action={actions} />

      {items.length === 0 ? (
        <p className="mt-2 text-xs leading-normal text-subtle">{emptyMessage}</p>
      ) : (
        <ul className="mt-2">
          {items.map((item) => (
            <li key={item.id} className="border-b border-line-soft last:border-b-0">
              <ThreadRow
                item={item}
                state={item.id === activeId ? 'selected' : 'default'}
                onSelect={onSelect === undefined ? undefined : () => onSelect(item.id)}
              />
            </li>
          ))}
        </ul>
      )}

      {footer === undefined ? null : <div className="mt-3">{footer}</div>}
    </Card>
  );
}
