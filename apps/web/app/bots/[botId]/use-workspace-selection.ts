'use client';

/**
 * The workspace's URL state: which thread is open and which evidence panel is
 * docked. Every change is pushed to history, and a browser back/forward event
 * reads the URL back into state, so the screen survives reload and deep link.
 */
import { useEffect, useState } from 'react';
import { readPanel, type PanelId } from '../../../lib/links';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

export interface WorkspaceSelection {
  readonly panel: PanelId | undefined;
  readonly thread: WorkspaceThread | undefined;
  readonly conversationHref: string;
  readonly selectThread: (nextThreadId: string) => void;
  readonly selectPanel: (key: PanelId) => void;
  readonly closePanel: () => void;
}

export function useWorkspaceSelection(
  data: WorkspaceData,
  initialThreadId: string | undefined,
  initialPanel: PanelId | undefined,
  onNavigate: () => void,
): WorkspaceSelection {
  const [threadId, setThreadId] = useState<string | undefined>(initialThreadId);
  const [panel, setPanel] = useState<PanelId | undefined>(initialPanel);

  const activeId = threadId ?? data.threads[0]?.id;
  const thread = data.threads.find((item) => item.id === activeId);

  useEffect(() => {
    function onPopState() {
      const params = new URLSearchParams(globalThis.location.search);
      setThreadId(params.get('thread') ?? undefined);
      setPanel(readPanel(params.get('panel') ?? undefined));
      onNavigate();
    }

    globalThis.addEventListener('popstate', onPopState);
    return () => globalThis.removeEventListener('popstate', onPopState);
  }, [onNavigate]);

  function selectThread(nextThreadId: string) {
    const target = data.threads.find((item) => item.id === nextThreadId);

    setThreadId(nextThreadId);
    setPanel(undefined);
    onNavigate();
    globalThis.history.pushState(null, '', target?.hrefs.conversation ?? data.bot.baseHref);
  }

  function selectPanel(key: PanelId) {
    const next = panel === key ? undefined : key;
    setPanel(next);
    globalThis.history.pushState(null, '', hrefFor(data, thread, threadId, next));
  }

  function closePanel() {
    const closed = panel;
    setPanel(undefined);
    globalThis.history.pushState(null, '', hrefFor(data, thread, threadId, undefined));

    globalThis.requestAnimationFrame(() => {
      if (closed === undefined) {
        return;
      }

      document.querySelector<HTMLElement>(`[data-panel="${closed}"]`)?.focus();
    });
  }

  const conversationHref =
    threadId === undefined ? data.bot.baseHref : (thread?.hrefs.conversation ?? data.bot.baseHref);

  return { panel, thread, conversationHref, selectThread, selectPanel, closePanel };
}

/** The URL for a selection; no thread or no panel means the Bot's base route. */
function hrefFor(
  data: WorkspaceData,
  thread: WorkspaceThread | undefined,
  nextThreadId: string | undefined,
  nextPanel: PanelId | undefined,
): string {
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
}
