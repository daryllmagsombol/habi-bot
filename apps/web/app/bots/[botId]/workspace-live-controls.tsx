'use client';

import { Button, FormMessage } from '../../../components/ui';
import type { LiveRun } from './use-live-run';

export interface WorkspaceLiveControlsProps {
  readonly liveRun: LiveRun;
}

/** Cancel, retry, the current Run identity, and the one live message line. */
export function WorkspaceLiveControls({ liveRun }: Readonly<WorkspaceLiveControlsProps>) {
  const runLabel =
    liveRun.run === undefined ? 'No run has started in this tab.' : `Run ${liveRun.run.id} · ${liveRun.run.state}`;

  return (
    <>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {liveRun.canCancel ? (
          <Button variant="secondary" size="sm" onClick={liveRun.cancel}>
            Stop run
          </Button>
        ) : null}
        {liveRun.canRetry ? (
          <Button variant="secondary" size="sm" onClick={liveRun.retry}>
            Retry
          </Button>
        ) : null}
        <span className="text-2xs text-subtle">{runLabel}</span>
      </div>

      <FormMessage
        className="mt-3"
        error={liveRun.error}
        status={liveRun.error === undefined ? liveRun.info : undefined}
      />
    </>
  );
}
