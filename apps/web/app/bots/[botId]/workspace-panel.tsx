'use client';

import { AnimatePresence, motion } from 'motion/react';
import {
  ArtifactPanel,
  ContextPanel,
  DocumentPanel,
  MemoryComposer,
  PanelCard,
  SearchPanel,
  SkillsPanel,
} from '../../../components/panels';
import type { PanelId } from '../../../lib/links';
import { DURATION, EASE, PANEL_OFFSET } from '../../../lib/motion';
import { panelRunOf } from './workspace-derived';
import type { LiveRun } from './use-live-run';
import type { WorkspaceActions } from './use-workspace-actions';
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
  readonly actions: WorkspaceActions;
  readonly onClose: () => void;
}

/**
 * The evidence card. On a phone it is a full-height sheet above the workspace;
 * on a wide screen it docks at the right edge. Keeping `AnimatePresence` mounted
 * lets the sheet play its exit animation when the panel closes.
 *
 * The Context panel composes the memory controls and the on-demand artifact,
 * skill and search sections. All of them receive data and callbacks; none of
 * them fetches.
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
  actions,
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
                documents={thread.documents}
                threadTitle={shownThreadTitle ?? thread.view.title}
                mode={data.mode}
              />
            ) : (
              <ContextPanel
                memories={data.memories}
                memoryState={data.memoryState}
                run={panelRunOf(thread, live, liveRun)}
                allowance={data.allowance}
                mode={data.mode}
                onMemoryToggle={live ? actions.toggleMemory : undefined}
                memoryChangedNote={
                  live
                    ? (actions.memoryError ?? actions.memoryStatus)
                    : 'Preview only — this change is not saved.'
                }
                memoryComposer={
                  live ? (
                    <MemoryComposer
                      threadId={thread.id}
                      onSubmit={actions.proposeMemory}
                      pending={actions.memoryPendingId === 'new'}
                      error={actions.memoryError}
                      status={actions.memoryStatus}
                    />
                  ) : (
                    <MemoryComposer
                      threadId={undefined}
                      onSubmit={() => {}}
                      disabledNote="Preview only — no memory is saved."
                    />
                  )
                }
                skillsSection={
                  live ? (
                    <SkillsPanel
                      skills={actions.skills}
                      botId={data.bot.id}
                      state={
                        actions.skillsState === 'idle' ? 'loading' : actions.skillsState
                      }
                      error={actions.skillsError}
                      onAttach={actions.attachSkillToBot}
                      onDetach={actions.detachSkillFromBot}
                      pendingId={actions.skillPendingId}
                    />
                  ) : undefined
                }
                searchSection={
                  live ? (
                    <SearchPanel
                      botId={data.bot.id}
                      results={actions.searchResults}
                      state={actions.searchState}
                      error={actions.searchError}
                      lastQuery={actions.searchQuery}
                      onSearch={actions.runSearch}
                    />
                  ) : undefined
                }
                artifactsSection={
                  live ? (
                    <ArtifactPanel
                      artifacts={actions.artifacts}
                      detail={actions.artifactDetail}
                      versions={actions.artifactVersions}
                      state={actions.artifactsState}
                      busy={actions.artifactBusy}
                      error={actions.artifactError}
                      status={actions.artifactStatus}
                      onSelect={actions.selectArtifact}
                      onSave={actions.saveArtifact}
                      onRestore={actions.restoreArtifact}
                    />
                  ) : undefined
                }
              />
            )}
          </PanelCard>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
