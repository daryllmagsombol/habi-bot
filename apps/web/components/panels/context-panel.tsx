import type { ReactNode } from 'react';
import { Badge, SectionHeader } from '../ui';
import { MemoryGates } from './memory-gates';
import type { AllowanceView, MemoryGateItem, PanelRun } from './types';

const COUNT = new Intl.NumberFormat('en-US');

export interface ContextPanelProps {
  readonly memories: readonly MemoryGateItem[];
  readonly run?: PanelRun | undefined;
  /** Absent when the API cannot report daily usage; the panel then says so. */
  readonly allowance?: AllowanceView | undefined;
  /** `live` drops preview-only wording without claiming unwired capability. */
  readonly mode?: 'preview' | 'live';
  /** Preview wording for the "changed" memory status; defaults live in MemoryGates. */
  readonly memoryChangedNote?: string;
  readonly className?: string;
}

function sectionId(title: string): string {
  return `context-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function Section({
  title,
  description,
  children,
}: Readonly<{ title: string; description?: string; children: ReactNode }>) {
  const id = sectionId(title);

  return (
    <section aria-labelledby={id} className="px-4 py-4">
      <SectionHeader as="h2" id={id} label={title} />
      {description === undefined ? null : (
        <p className="mt-1.5 text-xs leading-normal text-muted">{description}</p>
      )}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1.5 last:border-b-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="u-figures text-xs font-medium text-ink">{children}</dd>
    </div>
  );
}

function usageWidth(part: number, total: number): string {
  if (total <= 0) {
    return '0%';
  }

  return `${Math.min(100, (part / total) * 100).toFixed(2)}%`;
}

function RunFacts({ run }: Readonly<{ run: PanelRun }>) {
  const live = run.state === 'streaming' || run.state === 'queued';
  const total = run.inTokens + run.outTokens;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="u-figures text-sm font-medium text-ink">run {run.id}</p>
        <Badge tone={live ? 'accent' : 'neutral'} dot={live}>
          {run.state}
        </Badge>
      </div>

      {run.tokensKnown === false ? (
        <p className="mt-3 text-xs leading-normal text-muted">
          The server reported token usage as unknown for this run.
        </p>
      ) : (
        <>
          <div
            className="mt-3 flex h-1.5 overflow-hidden rounded-full bg-sunken"
            role="img"
            aria-label={`${COUNT.format(run.inTokens)} input tokens and ${COUNT.format(run.outTokens)} output tokens`}
          >
            <span className="bg-accent" style={{ width: usageWidth(run.inTokens, total) }} />
            <span className="bg-signal" style={{ width: usageWidth(run.outTokens, total) }} />
          </div>
          <p className="u-figures mt-1.5 flex justify-between text-2xs text-subtle">
            <span>{COUNT.format(run.inTokens)} in</span>
            <span>{COUNT.format(run.outTokens)} out</span>
          </p>
        </>
      )}

      <dl className="mt-3 border-t border-line-soft">
        <Fact label="Duration">
          {run.durationMs === undefined ? '—' : `${(run.durationMs / 1000).toFixed(1)}s`}
        </Fact>
        <Fact label="Tools allowed">{run.tools}</Fact>
        <Fact label="Events">{run.events.length}</Fact>
      </dl>

      <ol className="mt-3">
        {run.events.map((event) => (
          <li
            key={event.seq}
            className="u-figures grid grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-2 border-b border-line-soft py-1.5 text-2xs text-subtle last:border-b-0"
          >
            <span>{event.at}</span>
            <span className="text-ink">{event.label}</span>
            <span>seq {event.seq}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The evidence beside the conversation: what memory was allowed to reach the
 * run, what the run cost, how much of the day it used, and what the Bot was
 * permitted to touch. Nothing here is behind another click, because "what did
 * it cost and did it use anything?" is the claim the product has to keep.
 */
export function ContextPanel({
  memories,
  run,
  allowance,
  mode = 'preview',
  memoryChangedNote,
  className,
}: Readonly<ContextPanelProps>) {
  const live = mode === 'live';

  return (
    <div className={['divide-y divide-line-soft', className].filter(Boolean).join(' ')}>
      <Section
        title="Memory"
        description="A memory reaches a run only when this bot and this conversation both approve it."
      >
        {live ? (
          <p className="text-xs leading-normal text-muted">
            Memory records are not exposed by this API yet. None of them are shown here, and
            nothing below claims a memory was recalled.
          </p>
        ) : (
          <MemoryGates memories={memories} changedNote={memoryChangedNote} />
        )}
      </Section>

      <Section title="This run">
        {run === undefined ? (
          <p className="text-xs leading-normal text-muted">
            {live
              ? 'No run has been started in this tab. Run history is not exposed by this API yet.'
              : 'No run in this thread yet. Nothing has been dispatched.'}
          </p>
        ) : (
          <RunFacts run={run} />
        )}
      </Section>

      <Section title="Today">
        {allowance === undefined ? (
          <p className="text-xs leading-normal text-muted">
            Daily usage is not reported by this API yet, so no figure is shown.
          </p>
        ) : (
          <>
            <div className="flex h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
              <span
                className="bg-accent"
                style={{ width: usageWidth(allowance.used, allowance.limit) }}
              />
            </div>
            <p className="u-figures mt-1.5 flex items-baseline justify-between text-2xs text-subtle">
              <span>
                <b className="font-semibold text-ink">{COUNT.format(allowance.used)}</b> used
              </span>
              <span>{COUNT.format(allowance.limit)} / day</span>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-subtle">
              Resets at {allowance.reset}. The figure is intent, not enforcement: there is no
              pre-dispatch check or output bound in this preview.
            </p>
          </>
        )}
      </Section>

      <Section title="Capability">
        <dl className="border-t border-line-soft">
          <Fact label="Tools allowed">0</Fact>
          <Fact label="Allow-list">Empty</Fact>
          <Fact label="Attachments">{live ? 'Not exposed' : 'Read-only'}</Fact>
          <Fact label="Workspace">{live ? 'Owner-scoped' : 'One user'}</Fact>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          {live
            ? 'A Bot cannot call a tool, a shell, or a browser through this API, and the client cannot grant one.'
            : 'A bot in this preview cannot call a tool, a shell, or a browser — and this page does not demonstrate the server-side isolation the product requires.'}
        </p>
      </Section>
    </div>
  );
}
