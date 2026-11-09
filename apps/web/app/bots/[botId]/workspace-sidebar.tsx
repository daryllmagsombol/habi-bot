'use client';

import { useState } from 'react';
import { Card } from '../../../components/ui';
import { MemoryCard } from '../../../components/panels';
import { ThreadActions, ThreadForm, ThreadListCard } from '../../../components/threads';
import type { WorkspaceActions } from './use-workspace-actions';
import type { WorkspaceData } from './workspace-data';

export interface WorkspaceSidebarProps {
  readonly data: WorkspaceData;
  readonly activeId: string | undefined;
  readonly onSelectThread: (threadId: string) => void;
  readonly actions: WorkspaceActions;
}

/** The list column: the Bot's threads, then what memory reached this Bot. */
export function WorkspaceSidebar({
  data,
  activeId,
  onSelectThread,
  actions,
}: Readonly<WorkspaceSidebarProps>) {
  const live = data.mode === 'live';
  const [form, setForm] = useState<'create' | 'rename' | undefined>(undefined);
  const active = data.threads.find((thread) => thread.id === activeId);

  const footer =
    !live || form === undefined ? undefined : (
      <Card variant="dashed" radius="md" padding="sm" elevation="none">
        <ThreadForm
          mode={form}
          initialTitle={form === 'rename' ? active?.view.title : undefined}
          onSubmit={(title) => {
            if (form === 'create') {
              actions.createThreadForBot(title);
              return;
            }

            if (activeId !== undefined && title !== undefined) {
              actions.renameThreadById(activeId, title);
            }
          }}
          onCancel={() => setForm(undefined)}
          pending={actions.threadPending}
          error={actions.threadError}
          status={actions.threadStatus}
        />
      </Card>
    );

  return (
    <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-none lg:gap-4">
      <ThreadListCard
        label="Threads"
        headingId="bot-threads-title"
        items={data.threads.map((item) => item.listItem)}
        activeId={activeId}
        onSelect={onSelectThread}
        emptyMessage="No threads yet. The first one starts this Bot's history."
        actions={
          live ? (
            <ThreadActions
              onCreate={() => setForm('create')}
              onRename={active === undefined ? undefined : () => setForm('rename')}
            />
          ) : undefined
        }
        footer={
          live ? (
            footer
          ) : (
            <ThreadActions
              onCreate={() => {}}
              disabled
              disabledNote="Creating and renaming threads needs the chat API."
            />
          )
        }
      />
      <MemoryCard
        label="Memory"
        headingId="bot-memory-title"
        items={data.memoryItems}
        approvedCount={data.approvedMemories}
        emptyMessage={
          live
            ? data.memoryState === 'unavailable'
              ? 'The memory records could not be loaded from this API. Nothing is shown, so nothing can be mistaken for recalled.'
              : 'No memories saved for this Bot. A memory starts with both gates off.'
            : 'No memories saved. This bot starts every thread with nothing recalled.'
        }
        note="Both the bot and the thread have to approve a memory before a run can recall it."
      />
    </div>
  );
}
