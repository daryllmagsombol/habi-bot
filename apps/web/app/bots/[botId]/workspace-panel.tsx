'use client';

import { AnimatePresence, motion } from 'motion/react';
import { ContextPanel, DocumentPanel, PanelCard } from '../../../components/panels';
import type { PanelId } from '../../../lib/links';
import { DURATION, EASE, PANEL_OFFSET } from '../../../lib/motion';
import { panelRunOf } from './workspace-derived';
import type { LiveRun } from './use-live-run';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

export interface WorkspacePanelProps {
  readonly panel: PanelId | undefined;
  readonly data: WorkspaceData;
  readonly thread: WorkspaceThread | undefined;
  readonly shownThreadTitle: string | undefined;
  readonly live: boolean;
  readonly liveRun: LiveRun;
  readonly conversationHref: string;
  readonly reduceMotion: boolean | null;
  readonly onClose: () => void;
}

/**
 * The evidence card. On a phone it is a full-height sheet above the workspace;
 * on a wide screen it docks at the right edge. Keeping `AnimatePresence` mounted
 * lets the sheet play its exit animation when the panel closes.
 */
export function WorkspacePanel({
  panel,
  data,
  thread,
  shownThreadTitle,
  live,
  liveRun,
  conversationHref,
  reduceMotion,
  onClose,
}: Readonly<WorkspacePanelProps>) {
  return (
    <AnimatePresence initial={false}>
      {panel === undefined || thread === undefined ? null : (
        <motion.div
          key={panel}
          initial={reduceMotion === true ? false : { opacity: 0, x: PANEL_OFFSET }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion === true ? { opacity: 0 } : { opacity: 0, x: PANEL_OFFSET / 2 }}
          transition={{ duration: DURATION.base, ease: EASE }}
          className="fixed inset-x-0 top-[var(--habi-bar-height)] bottom-0 z-40 lg:inset-auto lg:top-[calc(var(--habi-bar-height)_+_var(--habi-space-4))] lg:right-6 lg:bottom-auto lg:h-[calc(100svh_-_var(--habi-bar-height)_-_var(--habi-space-7))] lg:w-panel"
        >
          <PanelCard
            panel={panel}
            titleId={`${panel}-panel-title`}
            closeHref={conversationHref}
            onClose={onClose}
          >
            {panel === 'document' ? (
              <DocumentPanel
                document={thread.document}
                threadTitle={shownThreadTitle ?? thread.view.title}
                mode={data.mode}
              />
            ) : (
              <ContextPanel
                memories={data.memories}
                run={panelRunOf(thread, live, liveRun)}
                allowance={data.allowance}
                mode={data.mode}
                {...previewMemoryNote(live)}
              />
            )}
          </PanelCard>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The preview-only note, absent in live mode without passing explicit undefined. */
function previewMemoryNote(live: boolean): { readonly memoryChangedNote?: string } {
  if (live) {
    return {};
  }

  return { memoryChangedNote: 'Preview only — this change is not saved.' };
}
