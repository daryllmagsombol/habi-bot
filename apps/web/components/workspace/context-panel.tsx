import type { ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { Panel } from '../ui/card';
import { MemoryGates } from './memory-gates';
import {
  formatCount,
  previewAllowance,
  type PreviewBot,
  type PreviewRun,
  type PreviewThread,
} from '../../lib/preview-data';

export interface ContextPanelProps {
  readonly bot: PreviewBot;
  readonly thread: PreviewThread;
}

function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-1.5 last:border-b-0">
      <dt className="text-xs text-muted">{label}</dt>
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

function RunFacts({ run }: Readonly<{ run: PreviewRun }>) {
  const live = run.state === 'streaming';
  const total = run.inTokens + run.outTokens;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="u-figures text-sm font-medium text-ink">run {run.id}</p>
        <Badge tone={live ? 'signal' : 'neutral'} dot={live}>
          {run.state}
        </Badge>
      </div>

      <div
        className="mt-3 flex h-1.5 overflow-hidden bg-sunken"
        role="img"
        aria-label={`${formatCount(run.inTokens)} input tokens and ${formatCount(run.outTokens)} output tokens`}
      >
        <span className="bg-accent" style={{ width: usageWidth(run.inTokens, total) }} />
        <span className="bg-signal" style={{ width: usageWidth(run.outTokens, total) }} />
      </div>
      <p className="u-figures mt-1.5 flex justify-between text-2xs text-muted">
        <span>{formatCount(run.inTokens)} in</span>
        <span>{formatCount(run.outTokens)} out</span>
      </p>

      <dl className="mt-3 border-t border-line">
        <Fact label="Duration">{(run.durationMs / 1000).toFixed(1)}s</Fact>
        <Fact label="Tools allowed">0</Fact>
        <Fact label="Events">{run.events.length}</Fact>
      </dl>

      <ol className="mt-3">
        {run.events.map((event) => (
          <li
            key={event.seq}
            className="u-figures grid grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-2 border-b border-line py-1.5 text-2xs text-muted last:border-b-0"
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
export function ContextPanel({ bot, thread }: Readonly<ContextPanelProps>) {
  const run = thread.messages.findLast((message) => message.run !== undefined)?.run;
  const allowancePercent = usageWidth(previewAllowance.used, previewAllowance.limit);

  return (
    <div>
      <Panel
        headingLevel={3}
        headingStyle="label"
        title="Memory"
        description="A memory reaches a run only when this Bot and this conversation both approve it."
        className="border-b border-line px-4 py-5 lg:px-6"
      >
        <MemoryGates memories={bot.memories} />
      </Panel>

      <Panel
        headingLevel={3}
        headingStyle="label"
        title="This run"
        className="border-b border-line px-4 py-5 lg:px-6"
      >
        {run === undefined ? (
          <p className="text-sm leading-relaxed text-muted">
            No run in this thread yet. Nothing has been dispatched.
          </p>
        ) : (
          <RunFacts run={run} />
        )}
      </Panel>

      <Panel
        headingLevel={3}
        headingStyle="label"
        title="Today"
        className="border-b border-line px-4 py-5 lg:px-6"
      >
        <div className="flex h-1.5 overflow-hidden bg-sunken" aria-hidden="true">
          <span className="bg-accent" style={{ width: allowancePercent }} />
        </div>
        <p className="u-figures mt-1.5 flex items-baseline justify-between text-2xs text-muted">
          <span>
            <b className="font-semibold text-ink">{formatCount(previewAllowance.used)}</b> used
          </span>
          <span>{formatCount(previewAllowance.limit)} / day</span>
        </p>
        <p className="mt-2 text-xs leading-relaxed text-subtle">
          Resets at {previewAllowance.reset}. The figure is intent, not enforcement: there is
          no pre-dispatch check or output bound in this preview.
        </p>
      </Panel>

      <Panel headingLevel={3} headingStyle="label" title="Capability" className="px-4 py-5 lg:px-6">
        <dl className="border-t border-line">
          <Fact label="Tools allowed">0</Fact>
          <Fact label="Allow-list">Empty</Fact>
          <Fact label="Attachments">Read-only</Fact>
          <Fact label="Workspace">One user</Fact>
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-subtle">
          A Bot in this preview cannot call a tool, a shell, or a browser — and this page
          does not demonstrate the server-side isolation the product requires.
        </p>
      </Panel>
    </div>
  );
}
