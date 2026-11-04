'use client';

import { MemoryCard } from '../../../components/panels';
import { ThreadListCard } from '../../../components/threads';
import type { WorkspaceData } from './workspace-data';

export interface WorkspaceSidebarProps {
  readonly data: WorkspaceData;
  readonly activeId: string | undefined;
  readonly onSelectThread: (threadId: string) => void;
}

/** The list column: the Bot's threads, then what memory reached this Bot. */
export function WorkspaceSidebar({
  data,
  activeId,
  onSelectThread,
}: Readonly<WorkspaceSidebarProps>) {
  const live = data.mode === 'live';

  return (
    <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-none lg:gap-4">
      <ThreadListCard
        label="Threads"
        headingId="bot-threads-title"
        items={data.threads.map((item) => item.listItem)}
        activeId={activeId}
        onSelect={onSelectThread}
        emptyMessage="No threads yet. The first one starts this Bot's history."
      />
      <MemoryCard
        label="Memory"
        headingId="bot-memory-title"
        items={data.memoryItems}
        approvedCount={data.approvedMemories}
        emptyMessage={
          live
            ? 'Memory records are not exposed by this API yet. Nothing is shown, so nothing can be mistaken for recalled.'
            : 'No memories saved. This bot starts every thread with nothing recalled.'
        }
        note="Both the bot and the thread have to approve a memory before a run can recall it."
      />
    </div>
  );
}
