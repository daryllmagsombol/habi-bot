'use client';

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArtifactPanel,
  ContextPanel,
  DocumentPanel,
  MemoryComposer,
  PaginationFooter,
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

interface PanelShellProps {
  readonly panel: PanelId;
  readonly conversationHref: string;
  readonly reduceMotion: boolean | null;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** The moving sheet on a phone, the docked card on a wide screen. */
function PanelShell({
  panel,
  conversationHref,
  reduceMotion,
  onClose,
  children,
}: Readonly<PanelShellProps>) {
  return (
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
        {children}
      </PanelCard>
    </motion.div>
  );
}

interface DocumentBodyProps {
  readonly thread: WorkspaceThread;
  readonly shownThreadTitle: string | undefined;
  readonly mode: WorkspaceData['mode'];
}

/** The document panel: the selected thread's attachments and their text. */
function DocumentBody({ thread, shownThreadTitle, mode }: Readonly<DocumentBodyProps>) {
  return (
    <DocumentPanel
      documents={thread.documents}
      threadTitle={shownThreadTitle ?? thread.view.title}
      mode={mode}
    />
  );
}

/** The memory status line under the gates; preview wording when not wired. */
function memoryChangedNote(live: boolean, actions: WorkspaceActions): string | undefined {
  if (!live) {
    return 'Preview only — this change is not saved.';
  }

  return actions.memoryError ?? actions.memoryStatus;
}

interface MemoryComposerSectionProps {
  readonly threadId: string;
  readonly live: boolean;
  readonly actions: WorkspaceActions;
}

/** The proposer, bound to the open thread only when a write can be saved. */
function MemoryComposerSection({
  threadId,
  live,
  actions,
}: Readonly<MemoryComposerSectionProps>) {
  if (!live) {
    return (
      <MemoryComposer
        threadId={undefined}
        onSubmit={() => {}}
        disabledNote="Preview only — no memory is saved."
      />
    );
  }

  return (
    <MemoryComposer
      threadId={threadId}
      onSubmit={actions.proposeMemory}
      pending={actions.memoryPendingId === 'new'}
      error={actions.memoryError}
      status={actions.memoryStatus}
    />
  );
}

/** The skill list, absent rather than empty when the panel is a preview. */
function skillsSectionOf(
  live: boolean,
  botId: string,
  botName: string,
  actions: WorkspaceActions,
): ReactNode {
  if (!live) {
    return undefined;
  }

  return (
    <SkillsPanel
      skills={actions.skills}
      botId={botId}
      botName={botName}
      state={actions.skillsState === 'idle' ? 'loading' : actions.skillsState}
      error={actions.skillsError}
      onAttach={actions.attachSkillToBot}
      onDetach={actions.detachSkillFromBot}
      pendingId={actions.skillPendingId}
      onCreate={actions.createSkillForAccount}
      createPending={actions.skillCreatePending}
      createError={actions.skillCreateError}
      createStatus={actions.skillCreateStatus}
      onUpdate={actions.updateSkillForAccount}
      updatePendingId={actions.skillUpdatePendingId}
      updateError={actions.skillUpdateError}
      updateStatus={actions.skillUpdateStatus}
      hasMore={actions.skillsPaging.hasMore}
      loadingMore={actions.skillsPaging.loading}
      pagingError={actions.skillsPaging.error}
      onLoadMore={actions.skillsPaging.loadMore}
    />
  );
}

/** The on-demand search box, absent rather than inert when not wired. */
function searchSectionOf(
  live: boolean,
  botId: string,
  actions: WorkspaceActions,
): ReactNode {
  if (!live) {
    return undefined;
  }

  return (
    <SearchPanel
      botId={botId}
      results={actions.searchResults}
      state={actions.searchState}
      error={actions.searchError}
      lastQuery={actions.searchQuery}
      onSearch={actions.runSearch}
      hasMore={actions.searchPaging.hasMore}
      loadingMore={actions.searchPaging.loading}
      pagingError={actions.searchPaging.error}
      onLoadMore={actions.searchPaging.loadMore}
    />
  );
}

/** The artifact list and editor, absent rather than empty when not wired. */
function artifactsSectionOf(
  live: boolean,
  threadId: string | undefined,
  actions: WorkspaceActions,
): ReactNode {
  if (!live) {
    return undefined;
  }

  return (
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
      onCreate={actions.createArtifactForThread}
      createPending={actions.artifactCreatePending}
      createError={actions.artifactCreateError}
      createStatus={actions.artifactCreateStatus}
      onUpdateMetadata={actions.updateArtifactMetadata}
      metadataPending={actions.artifactMetadataPending}
      metadataError={actions.artifactMetadataError}
      metadataStatus={actions.artifactMetadataStatus}
      canCreate={threadId !== undefined}
      createDisabledNote="Open a thread first: an artifact is bound to its conversation."
      hasMore={actions.artifactsPaging.hasMore}
      loadingMore={actions.artifactsPaging.loading}
      pagingError={actions.artifactsPaging.error}
      onLoadMore={actions.artifactsPaging.loadMore}
      versionsHasMore={actions.artifactVersionsPaging.hasMore}
      versionsLoadingMore={actions.artifactVersionsPaging.loading}
      versionsPagingError={actions.artifactVersionsPaging.error}
      onLoadMoreVersions={actions.artifactVersionsPaging.loadMore}
    />
  );
}

interface ContextBodyProps {
  readonly thread: WorkspaceThread;
  readonly live: boolean;
  readonly liveRun: LiveRun;
  readonly actions: WorkspaceActions;
  readonly data: WorkspaceData;
}

/** The context panel: memory controls plus the on-demand tool sections. */
function ContextBody({ thread, live, liveRun, actions, data }: Readonly<ContextBodyProps>) {
  return (
    <ContextPanel
      memories={live ? actions.memories : data.memories}
      memoryState={data.memoryState}
      run={panelRunOf(thread, live, liveRun)}
      allowance={data.allowance}
      mode={data.mode}
      onMemoryToggle={live ? actions.toggleMemory : undefined}
      memoryChangedNote={memoryChangedNote(live, actions)}
      memoryComposer={
        <MemoryComposerSection threadId={thread.id} live={live} actions={actions} />
      }
      memoryPaging={
        live ? (
          <PaginationFooter
            className="mt-2"
            hasMore={actions.memoryPaging.hasMore}
            loading={actions.memoryPaging.loading}
            error={actions.memoryPaging.error}
            label="Load more memories"
            loadingLabel="Loading more memories…"
            onLoadMore={actions.memoryPaging.loadMore}
          />
        ) : undefined
      }
      skillsSection={skillsSectionOf(live, data.bot.id, data.bot.name, actions)}
      searchSection={searchSectionOf(live, data.bot.id, actions)}
      artifactsSection={artifactsSectionOf(live, thread.id, actions)}
    />
  );
}

interface PanelBodyProps extends ContextBodyProps {
  readonly panel: PanelId;
  readonly shownThreadTitle: string | undefined;
}

/** Document or context: the one choice the panel makes. */
function PanelBody({
  panel,
  thread,
  shownThreadTitle,
  live,
  liveRun,
  actions,
  data,
}: Readonly<PanelBodyProps>) {
  if (panel === 'document') {
    return (
      <DocumentBody
        thread={thread}
        shownThreadTitle={shownThreadTitle}
        mode={data.mode}
      />
    );
  }

  return (
    <ContextBody
      thread={thread}
      live={live}
      liveRun={liveRun}
      actions={actions}
      data={data}
    />
  );
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
        <PanelShell
          panel={panel}
          conversationHref={conversationHref}
          reduceMotion={reduceMotion}
          onClose={onClose}
        >
          <PanelBody
            panel={panel}
            data={data}
            thread={thread}
            shownThreadTitle={shownThreadTitle}
            live={live}
            liveRun={liveRun}
            actions={actions}
          />
        </PanelShell>
      )}
    </AnimatePresence>
  );
}
