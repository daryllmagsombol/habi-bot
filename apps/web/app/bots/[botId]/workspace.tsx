'use client';

import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { AppBar } from '../../../components/app-bar';
import { BotIdentity } from '../../../components/bots';
import { ContextPanel, DocumentPanel, MemoryCard, PanelCard, PanelSwitch } from '../../../components/panels';
import { ThreadConversation, ThreadListCard } from '../../../components/threads';
import type { ComposerStatus } from '../../../components/threads';
import { Button, EmptyState, FormMessage, IconButton, PaperclipIcon, SkipLink } from '../../../components/ui';
import { readPanel, type PanelId } from '../../../lib/links';
import { DURATION, EASE, PANEL_OFFSET } from '../../../lib/motion';
import { runViewToPanel } from './api-data';
import { useLiveRun } from './use-live-run';
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
 * `WorkspaceData`. In live mode `useLiveRun` owns sends, the Run stream,
 * reconnect, and cancel; this component renders its state and never fetches.
 */
export function BotWorkspace({ data, initialThreadId, initialPanel }: Readonly<BotWorkspaceProps>) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [panel, setPanel] = useState<PanelId | undefined>(initialPanel);
  const reduceMotion = useReducedMotion();

  const activeId = threadId ?? data.threads[0]?.id;
  const thread: WorkspaceThread | undefined = data.threads.find((item) => item.id === activeId);
  const live = data.mode === 'live';
  const liveRun = useLiveRun(thread?.id, live);
  const resetLiveRun = liveRun.reset;

  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(globalThis.location.search);
      setThreadId(params.get('thread') ?? undefined);
      setPanel(readPanel(params.get('panel') ?? undefined));
      resetLiveRun();
    }

    globalThis.addEventListener('popstate', onPopState);
    return () => globalThis.removeEventListener('popstate', onPopState);
  }, [resetLiveRun]);

  const baseMessages =
    live && liveRun.messages !== undefined
      ? liveRun.messages
      : (thread?.view.messages ?? []);
  const shownThread =
    thread === undefined
      ? undefined
      : {
          ...thread.view,
          messages: [...baseMessages, ...(live ? liveRun.extra : [])],
        };

  const conversationHref =
    threadId === undefined ? data.bot.baseHref : (thread?.hrefs.conversation ?? data.bot.baseHref);

  const urlFor = (nextThreadId: string | undefined, nextPanel: PanelId | undefined): string => {
    if (thread === undefined) {
      return data.bot.baseHref;
    }

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
    resetLiveRun();
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

  const composerStatus: ComposerStatus | undefined = live
    ? liveRun.error !== undefined
      ? { kind: 'error', message: liveRun.error }
      : liveRun.phase === 'sending' ||
          liveRun.phase === 'waiting' ||
          liveRun.phase === 'streaming'
        ? { kind: 'disabled', message: liveRun.info ?? 'Sending…' }
        : undefined
    : undefined;

  const conversation =
    thread === undefined || shownThread === undefined ? (
      <div className="order-1 min-w-0 lg:order-none">
        <EmptyState
          headingLevel={2}
          title="No threads yet"
          description={
            live
              ? 'This Bot has no conversation in your account. Creating a thread is not exposed by this API yet, so there is nothing to open here.'
              : 'A Bot with no threads still has its instructions and memory. Opening the first thread is part of the wired workspace.'
          }
          action={<Button disabled>New thread</Button>}
        />
      </div>
    ) : (
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
          hint={
            <span className="hidden sm:inline">
              Enter sends · Shift + Enter adds a line
            </span>
          }
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

        {live ? (
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
              <span className="text-2xs text-subtle">
                {liveRun.run === undefined
                  ? 'No run has started in this tab.'
                  : `Run ${liveRun.run.id} · ${liveRun.run.state}`}
              </span>
            </div>

            <FormMessage
              className="mt-3"
              error={liveRun.error}
              status={liveRun.error === undefined ? liveRun.info : undefined}
            />
          </>
        ) : null}
      </motion.div>
    );

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <AppBar
          section="bots"
          counts={data.counts}
          allowance={data.allowance}
          mode={data.mode}
          actions={
            thread === undefined ? undefined : (
              <PanelSwitch
                panel={panel}
                documentHref={thread.hrefs.document}
                contextHref={thread.hrefs.context}
                conversationHref={conversationHref}
                onSelect={selectPanel}
              />
            )
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
                    title={
                      live
                        ? 'Not exposed by this API yet'
                        : 'Not available in this preview'
                    }
                    className="w-full sm:w-auto"
                  >
                    Edit instructions
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled
                    title={
                      live
                        ? 'Not exposed by this API yet'
                        : 'Not available in this preview'
                    }
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
                  activeId={thread?.id}
                  onSelect={selectThread}
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

              {conversation}
            </div>

            <p className="mt-4 max-w-[62ch] text-xs leading-relaxed text-subtle">
              {live
                ? 'This conversation is stored by the Habi API. A reply appears only when the worker writes run events, and no figure on this page is sample data.'
                : 'This thread is local sample data. Sending adds a message to this tab only; no model is called and no run is dispatched.'}
            </p>
          </div>
        </main>

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
                onClose={closePanel}
              >
                {panel === 'document' ? (
                  <DocumentPanel
                    document={thread.document}
                    threadTitle={shownThread?.title ?? thread.view.title}
                    mode={data.mode}
                  />
                ) : (
                  <ContextPanel
                    memories={data.memories}
                    run={
                      live && liveRun.run !== undefined
                        ? runViewToPanel(liveRun.run)
                        : thread.run
                    }
                    allowance={data.allowance}
                    mode={data.mode}
                    {...(live
                      ? {}
                      : { memoryChangedNote: 'Preview only — this change is not saved.' })}
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
