'use client';

import { MotionConfig, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';
import { SkipLink } from '../../../components/ui';
import type { PanelId } from '../../../lib/links';
import { useLiveRun } from './use-live-run';
import { useWorkspaceSelection } from './use-workspace-selection';
import { WorkspaceConversation } from './workspace-conversation';
import { composerStatusOf, shownThreadOf } from './workspace-derived';
import { WorkspaceHeader } from './workspace-header';
import { WorkspaceIdentity } from './workspace-identity';
import { WorkspacePanel } from './workspace-panel';
import { WorkspaceSidebar } from './workspace-sidebar';
import type { WorkspaceData } from './workspace-data';

export interface BotWorkspaceProps {
  readonly data: WorkspaceData;
  /** From `?thread=`. Absent means the newest thread, not an empty screen. */
  readonly initialThreadId: string | undefined;
  /** From `?panel=`. */
  readonly initialPanel: PanelId | undefined;
}

/**
 * A Bot's workspace: identity, the thread and memory cards, and one large
 * conversation card.
 *
 * The layout is a centred column, not a three-pane shell. Opening Document or
 * Context docks a narrow card at the right edge of the window and leaves the
 * reading measure untouched; on a phone the same panel is a full-height sheet
 * and the workspace content underneath is not rendered visible, so focus never
 * lands on a covered control.
 *
 * The route coordinator: it owns selection and the live run, then composes the
 * header, identity, sidebar, conversation and panel. Each of those renders one
 * slice of `WorkspaceData` and reports intent through callbacks; none of them
 * fetches, reads the URL, or decides what a run means.
 */
export function BotWorkspace({
  data,
  initialThreadId,
  initialPanel,
}: Readonly<BotWorkspaceProps>) {
  const live = data.mode === 'live';
  const reduceMotion = useReducedMotion();

  // Navigation resets the live run. The selection hook is created before the
  // run exists, so it calls the latest reset through this ref.
  const resetLiveRunRef = useRef<() => void>(() => {});
  const resetLiveRun = useCallback(() => resetLiveRunRef.current(), []);
  const selection = useWorkspaceSelection(data, initialThreadId, initialPanel, resetLiveRun);
  const liveRun = useLiveRun(selection.thread?.id, live);

  useEffect(() => {
    resetLiveRunRef.current = liveRun.reset;
  }, [liveRun.reset]);

  const shownThread = shownThreadOf(selection.thread, liveRun, live);
  const composerStatus = composerStatusOf(live, liveRun);
  const contentClassName = [
    'mx-auto w-full max-w-wide px-4 pb-16 sm:px-6 lg:pb-20',
    selection.panel === undefined ? '' : 'max-lg:hidden',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <WorkspaceHeader
          data={data}
          thread={selection.thread}
          panel={selection.panel}
          conversationHref={selection.conversationHref}
          onSelectPanel={selection.selectPanel}
        />

        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 focus:outline-none">
          <div className={contentClassName}>
            <WorkspaceIdentity data={data} />

            <div className="grid items-start gap-3 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-4">
              <WorkspaceSidebar
                data={data}
                activeId={selection.thread?.id}
                onSelectThread={selection.selectThread}
              />
              <WorkspaceConversation
                data={data}
                thread={selection.thread}
                shownThread={shownThread}
                live={live}
                liveRun={liveRun}
                composerStatus={composerStatus}
                reduceMotion={reduceMotion}
              />
            </div>

            <p className="mt-4 max-w-[62ch] text-xs leading-relaxed text-subtle">
              {live
                ? 'This conversation is stored by the Habi API. A reply appears only when the worker writes run events, and no figure on this page is sample data.'
                : 'This thread is local sample data. Sending adds a message to this tab only; no model is called and no run is dispatched.'}
            </p>
          </div>
        </main>

        <WorkspacePanel
          panel={selection.panel}
          data={data}
          thread={selection.thread}
          shownThreadTitle={shownThread?.title}
          live={live}
          liveRun={liveRun}
          conversationHref={selection.conversationHref}
          reduceMotion={reduceMotion}
          onClose={selection.closePanel}
        />
      </div>
    </MotionConfig>
  );
}
