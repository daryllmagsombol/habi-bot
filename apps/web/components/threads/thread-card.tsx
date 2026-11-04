import type { ReactNode } from 'react';
import { Card, MetaRow, type MetaItem } from '../ui';

export interface ThreadCardProps {
  readonly title: ReactNode;
  /** Id for the title, so the card can be labelled by it. */
  readonly headingId?: string | undefined;
  readonly metaItems: readonly MetaItem[];
  /** The transcript list. */
  readonly transcript: ReactNode;
  /** Optional run strip, placed between the transcript and the composer. */
  readonly runStrip?: ReactNode;
  readonly composer: ReactNode;
  readonly className?: string;
}

/**
 * The conversation card: title, meta line, transcript, run strip, and composer.
 *
 * A layout shell only. The transcript and composer arrive as slots, so the same
 * card can hold sample turns, a streamed answer, or a disabled composer without
 * knowing which.
 */
export function ThreadCard({
  title,
  headingId,
  metaItems,
  transcript,
  runStrip,
  composer,
  className,
}: Readonly<ThreadCardProps>) {
  return (
    <Card
      as="section"
      radius="xl"
      elevation="card"
      aria-labelledby={headingId}
      className={['overflow-hidden', className].filter(Boolean).join(' ')}
    >
      <header className="border-b border-line-soft px-4 py-3 sm:px-5">
        <h2
          id={headingId}
          className="text-sm leading-snug font-semibold tracking-heading text-ink"
        >
          {title}
        </h2>
        <MetaRow items={metaItems} className="mt-1 text-subtle" />
      </header>

      <div className="px-4 py-4 sm:px-5">{transcript}</div>

      {runStrip === undefined ? null : <div className="px-4 pb-3 sm:px-5">{runStrip}</div>}

      <div className="px-4 pb-[calc(var(--habi-space-4)_+_env(safe-area-inset-bottom))] sm:px-5">
        {composer}
      </div>
    </Card>
  );
}
