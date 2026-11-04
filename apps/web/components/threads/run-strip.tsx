import { ChevronRightIcon } from '../ui';
import type { RunView } from './types';

const COUNT = new Intl.NumberFormat('en-US');

export interface RunStripProps {
  readonly run: RunView;
  readonly className?: string;
}

/**
 * The run behind the reply: id, state, token split, tools, duration, and an
 * optional event log.
 *
 * A native `<details>` when there is an event log — keyboard-operable, no
 * script, and the summary already answers "what did it cost, and did it use
 * anything?". With no events it is a plain strip, not an empty disclosure.
 */
export function RunStrip({ run, className }: Readonly<RunStripProps>) {
  const live = run.state === 'streaming';
  const expandable = run.events.length > 0;

  const summary = (
    <>
      <span
        className={[
          'inline-flex items-center gap-1.5 font-semibold',
          live ? 'text-accent-ink' : 'text-subtle',
        ].join(' ')}
      >
        {live ? <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" /> : null}
        Run {run.id}
      </span>
      <span>{run.state}</span>
      {run.tokensKnown === false ? (
        <span className="u-figures">tokens unknown</span>
      ) : (
        <span className="u-figures">
          <b className="font-semibold text-muted">{COUNT.format(run.inTokens)}</b> in ·{' '}
          <b className="font-semibold text-muted">{COUNT.format(run.outTokens)}</b> out
        </span>
      )}
      <span className="u-figures">tools {run.tools}</span>
      {run.durationMs === undefined ? null : (
        <span className="u-figures ml-auto inline-flex items-center gap-1">
          {(run.durationMs / 1000).toFixed(0)}s
          {expandable ? (
            <ChevronRightIcon
              size={12}
              className="rotate-90 transition-transform duration-[var(--habi-duration-fast)] ease-standard group-open:-rotate-90 motion-reduce:transition-none"
            />
          ) : null}
        </span>
      )}
    </>
  );

  const summaryClass = [
    'flex min-h-11 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line-soft',
    'bg-canvas/70 px-3 py-2 text-2xs text-subtle',
  ].join(' ');

  if (!expandable) {
    return <div className={[summaryClass, className].filter(Boolean).join(' ')}>{summary}</div>;
  }

  return (
    <details className={['group', className].filter(Boolean).join(' ')}>
      <summary
        className={[
          summaryClass,
          'list-none cursor-pointer transition-colors hover:bg-sunken/60 [&::-webkit-details-marker]:hidden',
        ].join(' ')}
      >
        {summary}
      </summary>

      <ol className="mt-2 rounded-lg border border-line-soft bg-surface px-3 py-1">
        {run.events.map((event) => (
          <li
            key={event.seq}
            className="u-figures grid grid-cols-[4.5rem_minmax(0,1fr)_auto] gap-2 border-b border-line-soft py-1.5 text-2xs text-subtle last:border-b-0"
          >
            <span>{event.at}</span>
            <span className="text-ink">{event.label}</span>
            <span>seq {event.seq}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
