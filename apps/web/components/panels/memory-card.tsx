import type { ReactNode } from 'react';
import { Card, SectionHeader } from '../ui';
import type { MemoryItem } from './types';

const DEFAULT_NOTE =
  'Both the bot and the thread have to approve a memory before a run can recall it.';

export interface MemoryCardProps {
  readonly label: string;
  readonly items: readonly MemoryItem[];
  /** Passed in so the card never decides an approval. */
  readonly approvedCount: number;
  readonly headingId: string;
  readonly emptyMessage: ReactNode;
  readonly note?: ReactNode;
  readonly className?: string;
}

/**
 * The saved memories beside a conversation: a count, which ones are approved
 * for both gates, and the rule that produced that answer.
 *
 * A summary, not a control. The approvals that can be changed live in the
 * Context panel; this card explains the state at a glance.
 */
export function MemoryCard({
  label,
  items,
  approvedCount,
  headingId,
  emptyMessage,
  note = DEFAULT_NOTE,
  className,
}: Readonly<MemoryCardProps>) {
  return (
    <Card as="section" radius="lg" padding="sm" aria-labelledby={headingId} className={className}>
      <SectionHeader as="h2" id={headingId} label={label} count={`${items.length} saved`} />

      {items.length === 0 ? (
        <p className="mt-2 text-xs leading-normal text-muted">{emptyMessage}</p>
      ) : (
        <>
          <p className="mt-1.5 text-[0.875rem] leading-normal text-muted">
            {approvedCount} of {items.length} approved for this bot and this thread.
          </p>

          <ul className="mt-3 grid gap-2">
            {items.map((memory) => (
              <li
                key={memory.id}
                className="flex items-start gap-2 text-xs leading-snug text-muted"
              >
                <span
                  aria-hidden="true"
                  className={[
                    'mt-1.5 size-[7px] shrink-0 rounded-full',
                    memory.recalled ? 'bg-success' : 'ring-[1.5px] ring-line-strong',
                  ].join(' ')}
                />
                <span>
                  {memory.text}
                  <span className="sr-only">
                    {memory.recalled
                      ? ' Approved for this bot and this thread.'
                      : ' Held back — not approved for this thread.'}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs leading-relaxed text-subtle">{note}</p>
        </>
      )}
    </Card>
  );
}
