'use client';

import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { AppBar } from '../app-bar';
import { Badge } from '../ui/badge';
import { Segmented, type SegmentedItem } from '../ui/segmented';
import { Sheet } from '../ui/sheet';
import { SkipLink } from '../ui/skip-link';
import { ContextPanel } from './context-panel';
import { DocumentPanel } from './document-panel';
import { ThreadConversation } from './thread-conversation';
import { ThreadRail } from './thread-rail';
import { findAttachment, findThread, type PreviewBot } from '../../lib/preview-data';
import { botHref, readPanel, threadHref, type PanelId } from '../../lib/links';
import { DURATION, EASE, PANEL_OFFSET } from '../../lib/motion';

export interface BotWorkspaceProps {
  readonly bot: PreviewBot;
  /** From `?thread=`. Absent means the phone opens on the thread list. */
  readonly initialThreadId?: string | undefined;
  /** From `?panel=`. */
  readonly initialPanel?: PanelId | undefined;
}

/**
 * A Bot's workspace: thread rail, conversation, and the evidence panel.
 *
 * The URL stays the source of truth for which thread and panel are open — every
 * view is still linkable and reloadable — but selection is handled in place so
 * the rail, the conversation, and the panel can animate between states instead
 * of repainting from the server. Links keep real hrefs, so a middle click, a
 * modified click, or a browser without JavaScript still navigates.
 */
export function BotWorkspace({ bot, initialThreadId, initialPanel }: Readonly<BotWorkspaceProps>) {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [panel, setPanelState] = useState<PanelId | undefined>(initialPanel);
  /* Keeps the third grid column while a closing panel animates out; cleared
   * when the exit finishes, so the layout never animates its width. */
  const [keepPanelColumn, setKeepPanelColumn] = useState(initialPanel !== undefined);
  const panelRef = useRef<PanelId | undefined>(initialPanel);

  const reduceMotion = useReducedMotion();

  /* Every panel change goes through here, so the ref the exit callback reads is
   * always the state the reader is looking at. A closing panel keeps its column
   * until the animation ends; an opening or replacing one claims it at once. */
  function applyPanel(next: PanelId | undefined) {
    panelRef.current = next;
    setPanelState(next);

    if (next !== undefined) {
      setKeepPanelColumn(true);
    }
  }

  /* Native history, so Back steps through panel → conversation → list without
   * a round trip. The listener keeps our state aligned with the address bar. */
  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(window.location.search);
      setThreadId(params.get('thread') ?? undefined);
      applyPanel(readPanel(params.get('panel') ?? undefined));
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const thread = findThread(bot, threadId);

  if (thread === undefined) {
    return null;
  }

  const attachment = findAttachment(thread);
  const conversationHref = threadHref(bot.id, thread.id);
  const documentHref = threadHref(bot.id, thread.id, 'document');
  const contextHref = threadHref(bot.id, thread.id, 'context');
  const live = thread.messages.at(-1)?.streaming === true;
  const run = thread.messages.findLast((message) => message.run !== undefined)?.run;

  const urlFor = (nextThreadId: string | undefined, nextPanel: PanelId | undefined): string => {
    if (nextThreadId === undefined && nextPanel === undefined) {
      return botHref(bot.id);
    }

    const id = nextThreadId ?? thread.id;
    return nextPanel === undefined ? threadHref(bot.id, id) : threadHref(bot.id, id, nextPanel);
  };

  const navigate = (nextThreadId: string | undefined, nextPanel: PanelId | undefined) => {
    window.history.pushState(null, '', urlFor(nextThreadId, nextPanel));
  };

  const selectThread = (nextThreadId: string) => {
    setThreadId(nextThreadId);
    applyPanel(undefined);
    navigate(nextThreadId, undefined);
  };

  const selectPanelByKey = (key: string) => {
    const next: PanelId | undefined =
      panel === key ? undefined : key === 'context' ? 'context' : 'document';
    applyPanel(next);
    navigate(threadId, next);
  };

  const selectView = (key: string) => {
    if (key === 'thread') {
      const nextThreadId = threadId ?? thread.id;
      setThreadId(nextThreadId);
      applyPanel(undefined);
      navigate(nextThreadId, undefined);
      return;
    }

    selectPanelByKey(key);
  };

  const closePanel = () => {
    applyPanel(undefined);
    navigate(threadId, undefined);
  };

  const showThreadList = () => {
    setThreadId(undefined);
    applyPanel(undefined);
    navigate(undefined, undefined);
  };

  const panelOpen = panel !== undefined || keepPanelColumn;
  const hideConversationOnMobile = panel !== undefined || threadId === undefined;
  const backHref =
    panel !== undefined ? conversationHref : threadId !== undefined ? botHref(bot.id) : '/bots';
  const backLabel =
    panel !== undefined ? 'the thread' : threadId !== undefined ? `${bot.name} threads` : 'all Bots';
  const onBack =
    panel !== undefined ? closePanel : threadId !== undefined ? showThreadList : undefined;

  const panelItems: readonly SegmentedItem[] = [
    {
      key: 'document',
      label: 'Document',
      href: panel === 'document' ? conversationHref : documentHref,
      current: panel === 'document',
    },
    {
      key: 'context',
      label: 'Context',
      href: panel === 'context' ? conversationHref : contextHref,
      current: panel === 'context',
    },
  ];

  const mobileItems: readonly SegmentedItem[] = [
    { key: 'thread', label: 'Thread', href: conversationHref, current: panel === undefined },
    ...panelItems,
  ];

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <AppBar
          fluid
          section="bots"
          title={bot.name}
          backHref={backHref}
          backLabel={backLabel}
          onBack={onBack}
          actions={
            <div className="hidden lg:block">
              <Segmented label="Thread panels" items={panelItems} onSelect={selectPanelByKey} />
            </div>
          }
        >
          <Segmented block label="Thread views" items={mobileItems} onSelect={selectView} />
        </AppBar>

        <main id="main-content" tabIndex={-1} className="min-h-0 flex-1 focus:outline-none">
          <div
            className={[
              'w-full lg:grid lg:h-[calc(100svh-var(--habi-bar-height))]',
              panelOpen
                ? 'lg:grid-cols-[var(--habi-width-rail)_minmax(0,1fr)_var(--habi-width-panel)]'
                : 'lg:grid-cols-[var(--habi-width-rail)_minmax(0,1fr)]',
            ].join(' ')}
          >
            <ThreadRail
              bot={bot}
              activeThreadId={thread.id}
              hiddenOnMobile={panel !== undefined || threadId !== undefined}
              onSelectThread={selectThread}
            />

            <motion.section
              key={`${thread.id}:${threadId === undefined ? 'default' : 'explicit'}`}
              initial={reduceMotion === true ? false : { opacity: 0, y: PANEL_OFFSET / 2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DURATION.base, ease: EASE }}
              aria-labelledby="thread-title"
              className={[
                'flex min-h-0 flex-col bg-canvas',
                hideConversationOnMobile ? 'max-lg:hidden' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="border-b border-line bg-surface">
                <div className="mx-auto w-full max-w-reading px-4 py-3 lg:px-6">
                  <h2 id="thread-title" className="text-title tracking-heading text-ink">
                    {thread.title}
                  </h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted">
                    {[bot.name, thread.at, attachment?.name]
                      .filter((item): item is string => typeof item === 'string')
                      .map((item, index, items) => (
                        <span
                          key={item}
                          className="inline-flex items-center gap-2.5 whitespace-nowrap"
                        >
                          <span
                            className={[
                              index === 1 ? 'u-figures' : '',
                              index === 0 ? 'max-sm:hidden' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                          >
                            {item}
                          </span>
                          {index < items.length - 1 ? (
                            <span
                              aria-hidden="true"
                              className={index === 0 ? 'max-sm:hidden' : ''}
                            >
                              ·
                            </span>
                          ) : null}
                        </span>
                      ))}
                    {run === undefined ? null : (
                      <Badge tone={live ? 'signal' : 'neutral'} dot={live} className="ml-0.5">
                        run {run.id} · {run.state}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>

              <ThreadConversation
                botName={bot.name}
                thread={thread}
                documentHref={attachment === undefined ? undefined : documentHref}
              />
            </motion.section>

            <AnimatePresence
              initial={false}
              onExitComplete={() => {
                if (panelRef.current === undefined) {
                  setKeepPanelColumn(false);
                }
              }}
            >
              {panel === undefined ? null : (
                <motion.div
                  key={panel}
                  initial={reduceMotion === true ? false : { opacity: 0, x: PANEL_OFFSET }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduceMotion === true ? { opacity: 0 } : { opacity: 0, x: PANEL_OFFSET / 2 }}
                  transition={{ duration: DURATION.base, ease: EASE }}
                  className="flex min-h-0 flex-col max-lg:min-h-[calc(100svh-var(--habi-bar-height)-3.25rem)]"
                >
                  <Sheet
                    title={panel === 'document' ? 'Document' : 'Context'}
                    titleId={`${panel}-panel-title`}
                    closeHref={conversationHref}
                    closeLabel="Close panel"
                    onClose={closePanel}
                    className="h-full"
                  >
                    {panel === 'document' ? (
                      <DocumentPanel attachment={attachment} threadTitle={thread.title} />
                    ) : (
                      <ContextPanel bot={bot} thread={thread} />
                    )}
                  </Sheet>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </main>
      </div>
    </MotionConfig>
  );
}
