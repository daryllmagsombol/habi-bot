/**
 * Pure derivations for the Bot workspace.
 *
 * The route coordinator passes one `WorkspaceData` and one `LiveRun` in; these
 * helpers turn them into the exact props a component renders, so no component
 * has to branch on `mode` or on the Run phase itself.
 */
import type { PanelRun } from '../../../components/panels';
import type { ComposerStatus, ThreadView } from '../../../components/threads';
import { runViewToPanel } from './api-data';
import type { LiveRun } from './use-live-run';
import type { WorkspaceThread } from './workspace-data';

/** The thread as rendered: the persisted turns, plus this tab's live turns. */
export function shownThreadOf(
  thread: WorkspaceThread | undefined,
  liveRun: LiveRun,
  live: boolean,
): ThreadView | undefined {
  if (thread === undefined) {
    return undefined;
  }

  const reloaded = live ? liveRun.messages : undefined;
  const messages = reloaded ?? thread.view.messages;
  const extra = live ? liveRun.extra : [];

  return { ...thread.view, messages: [...messages, ...extra] };
}

function busyComposerStatus(liveRun: LiveRun): ComposerStatus | undefined {
  const busy =
    liveRun.phase === 'sending' ||
    liveRun.phase === 'waiting' ||
    liveRun.phase === 'streaming';

  if (!busy) {
    return undefined;
  }

  return { kind: 'disabled', message: liveRun.info ?? 'Sending…' };
}

/** The composer speaks only for the live run; preview keeps its own hint. */
export function composerStatusOf(
  live: boolean,
  liveRun: LiveRun,
): ComposerStatus | undefined {
  if (!live) {
    return undefined;
  }

  if (liveRun.error === undefined) {
    return busyComposerStatus(liveRun);
  }

  return { kind: 'error', message: liveRun.error };
}

/**
 * The run the Context panel shows: this tab's stream when it has one, otherwise
 * the run stored on the thread. The API links no history, so `undefined` stays
 * `undefined` rather than becoming an invented run.
 */
export function panelRunOf(
  thread: WorkspaceThread,
  live: boolean,
  liveRun: LiveRun,
): PanelRun | undefined {
  if (live && liveRun.run !== undefined) {
    return runViewToPanel(liveRun.run);
  }

  return thread.run;
}
