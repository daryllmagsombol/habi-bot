'use client';

import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { AppBar } from '../../../components/app-bar';
import { BotIdentity } from '../../../components/bots';
import { ContextPanel, DocumentPanel, MemoryCard, PanelCard, PanelSwitch } from '../../../components/panels';
import { ThreadConversation, ThreadListCard } from '../../../components/threads';
import { Button, IconButton, PaperclipIcon, SkipLink } from '../../../components/ui';
import { readPanel, type PanelId } from '../../../lib/links';
import { DURATION, EASE, PANEL_OFFSET } from '../../../lib/motion';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

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
 * Pure composition and URL state: the route selects the data and hands it in as
 * `WorkspaceData`, so this component never imports sample records. The cards,
 * rows, bubbles, composer and panels are all components from `bots`, `threads`,
 * `panels`, and `ui`.
 */
export function BotWorkspace({ data, initialThreadId, initialPanel }: Readonly<BotWorkspaceProps>) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [panel, setPanel] = useState<PanelId | undefined>(initialPanel);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(globalThis.location.search);
      setThreadId(params.get('thread') ?? undefined);
      setPanel(readPanel(params.get('panel') ?? undefined));
    }

    globalThis.addEventListener('popstate', onPopState);
    return () => globalThis.removeEventListener('popstate', onPopState);
  }, []);

  const activeId = threadId ?? data.threads[0]?.id;
  const thread: WorkspaceThread | undefined = data.threads.find((item) => item.id === activeId);

  if (thread === undefined) {
    return null;
  }

  const conversationHref = threadId === undefined ? data.bot.baseHref : thread.hrefs.conversation;

  const urlFor = (nextThreadId: string | undefined, nextPanel: PanelId | undefined): string => {
    if (nextThreadId === undefined && nextPanel === undefined) {
      return data.bot.baseHref;
    }

    const target = data.threads.find((item) => item.id === (nextThreadId ?? thread.id));

    if (target === undefined) {
      return data.bot.baseHref;
    }

    if (nextPanel === undefined) {
      return target.hrefs.conversation;
    }

    return nextPanel === 'document' ? target.hrefs.document : target.hrefs.context;
  };

  const selectThread = (nextThreadId: string) => {
    const target = data.threads.find((item) => item.id === nextThreadId);

    setThreadId(nextThreadId);
    setPanel(undefined);
    globalThis.history.pushState(null, '', target?.hrefs.conversation ?? data.bot.baseHref);
  };

  const selectPanel = (key: PanelId) => {
    const next = panel === key ? undefined : key;
    setPanel(next);
    globalThis.history.pushState(null, '', urlFor(threadId, next));
  };

  const closePanel = () => {
    const closed = panel;
    setPanel(undefined);
    globalThis.history.pushState(null, '', urlFor(threadId, undefined));

    globalThis.requestAnimationFrame(() => {
      if (closed === undefined) {
        return;
      }

      document.querySelector<HTMLElement>(`[data-panel="${closed}"]`)?.focus();
    });
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <AppBar
          section="bots"
          counts={data.counts}
          allowance={data.allowance}
          actions={
            <PanelSwitch
              panel={panel}
              documentHref={thread.hrefs.document}
              contextHref={thread.hrefs.context}
              conversationHref={conversationHref}
              onSelect={selectPanel}
            />
          }
        />

        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 focus:outline-none">
          <div
            className={[
              'mx-auto w-full max-w-wide px-4 pb-16 sm:px-6 lg:pb-20',
              panel === undefined ? '' : 'max-lg:hidden',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <BotIdentity
              backHref="/bots"
              name={data.bot.name}
              initials={data.bot.initials}
              tone={data.bot.tone}
              summary={data.bot.summary}
              actions={
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled
                    title="Not available in this preview"
                    className="w-full sm:w-auto"
                  >
                    Edit instructions
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled
                    title="Not available in this preview"
                    className="w-full sm:w-auto"
                  >
                    New thread
                  </Button>
                </>
              }
            />

            <div className="grid items-start gap-3 lg:grid-cols-[17rem_minmax(0,1fr)] lg:gap-4">
              <div className="order-2 flex min-w-0 flex-col gap-3 lg:order-none lg:gap-4">
                <ThreadListCard
                  label="Threads"
                  headingId="bot-threads-title"
                  items={data.threads.map((item) => item.listItem)}
                  activeId={thread.id}
                  onSelect={selectThread}
                  emptyMessage="No threads yet. The first one starts this Bot's history."
                />
                <MemoryCard
                  label="Memory"
                  headingId="bot-memory-title"
                  items={data.memoryItems}
                  approvedCount={data.approvedMemories}
                  emptyMessage="No memories saved. This bot starts every thread with nothing recalled."
                  note="Both the bot and the thread have to approve a memory before a run can recall it."
                />
              </div>

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
                  thread={thread.view}
                  headingId="thread-title"
                  hint={
                    <span className="hidden sm:inline">
                      Enter sends · Shift + Enter adds a line
                    </span>
                  }
                  sendNotice="Added to this thread locally. No run is dispatched in this preview."
                  localFootnote="Local only · not sent"
                  attachment={
                    <IconButton
                      label="Attach a document — not available in this preview"
                      disabled
                      icon={<PaperclipIcon size={17} />}
                    />
                  }
                />
              </motion.div>
            </div>

            <p className="mt-4 max-w-[62ch] text-xs leading-relaxed text-subtle">
              This thread is local sample data. Sending adds a message to this tab only; no model
              is called and no run is dispatched.
            </p>
          </div>
        </main>

        <AnimatePresence initial={false}>
          {panel === undefined ? null : (
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
                onClose={closePanel}
              >
                {panel === 'document' ? (
                  <DocumentPanel document={thread.document} threadTitle={thread.view.title} />
                ) : (
                  <ContextPanel
                    memories={data.memories}
                    run={thread.run}
                    allowance={data.allowance}
                    memoryChangedNote="Preview only — this change is not saved."
                  />
                )}
              </PanelCard>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
