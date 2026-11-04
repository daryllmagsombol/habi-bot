'use client';

import { motion } from 'motion/react';
import { ThreadConversation } from '../../../components/threads';
import type { ComposerStatus, ThreadView } from '../../../components/threads';
import { IconButton, PaperclipIcon } from '../../../components/ui';
import { DURATION, EASE } from '../../../lib/motion';
import { WorkspaceEmptyThread } from './workspace-empty-thread';
import { WorkspaceLiveControls } from './workspace-live-controls';
import type { LiveRun } from './use-live-run';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

export interface WorkspaceConversationProps {
  readonly data: WorkspaceData;
  readonly thread: WorkspaceThread | undefined;
  readonly shownThread: ThreadView | undefined;
  readonly live: boolean;
  readonly liveRun: LiveRun;
  readonly composerStatus: ComposerStatus | undefined;
  readonly reduceMotion: boolean | null;
}

/** The reading column: one empty state, or the thread plus its live controls. */
export function WorkspaceConversation({
  data,
  thread,
  shownThread,
  live,
  liveRun,
  composerStatus,
  reduceMotion,
}: Readonly<WorkspaceConversationProps>) {
  if (thread === undefined || shownThread === undefined) {
    return <WorkspaceEmptyThread live={live} />;
  }

  return (
    <motion.div
      key={thread.id}
      initial={reduceMotion === true ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.base, ease: EASE }}
      className="order-1 min-w-0 lg:order-none"
    >
      <ThreadConversation
        bot={{ name: data.bot.name, initials: data.bot.initials }}
        owner={data.owner}
        thread={shownThread}
        headingId="thread-title"
        hint={<span className="hidden sm:inline">Enter sends · Shift + Enter adds a line</span>}
        sendNotice={
          live
            ? 'Message saved. A reply appears when the run writes events.'
            : 'Added to this thread locally. No run is dispatched in this preview.'
        }
        localFootnote={live ? 'Optimistic turn · not yet confirmed' : 'Local only · not sent'}
        onSend={live ? liveRun.send : undefined}
        draft={live ? liveRun.draft : undefined}
        onDraftChange={live ? liveRun.setDraft : undefined}
        composerStatus={composerStatus}
        attachment={
          <IconButton
            label={
              live
                ? 'Attach a document — not exposed by this API'
                : 'Attach a document — not available in this preview'
            }
            disabled
            icon={<PaperclipIcon size={17} />}
          />
        }
      />

      {live ? <WorkspaceLiveControls liveRun={liveRun} /> : null}
    </motion.div>
  );
}
