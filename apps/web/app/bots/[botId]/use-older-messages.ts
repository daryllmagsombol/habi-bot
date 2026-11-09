'use client';

/**
 * Older-message paging for the selected thread.
 *
 * The cursor is the page's `before` value, never a timestamp. A successful page
 * is prepended to the transcript; the live stream and this tab's optimistic
 * turns live separately, so loading history never disturbs them.
 */
import { useEffect, useRef, useState } from 'react';
import type { TranscriptMessage } from '../../../components/threads';
import { readMessages } from '../../../lib/api/browser';
import { messageToTranscript } from './api-data';
import type { WorkspaceThread } from './workspace-data';

export interface OlderMessages {
  readonly messages: readonly TranscriptMessage[];
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly loadOlder: () => void;
}

const ERROR_COPY = 'Older messages could not be loaded. The loaded transcript was kept.';

export function useOlderMessages(
  thread: WorkspaceThread | undefined,
  live: boolean,
): OlderMessages {
  const [messages, setMessages] = useState<readonly TranscriptMessage[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const threadRef = useRef<string | undefined>(thread?.id);

  useEffect(() => {
    if (threadRef.current === thread?.id) {
      return;
    }

    threadRef.current = thread?.id;
    setMessages([]);
    setCursor(thread?.beforeCursor ?? null);
    setHasMore(thread?.hasMoreBefore === true);
    setLoading(false);
    setError(undefined);
  }, [thread?.id, thread?.beforeCursor, thread?.hasMoreBefore]);

  // The first render of a thread still needs its cursor, even though the reset
  // effect has not run yet.
  const activeCursor = cursor === undefined ? (thread?.beforeCursor ?? null) : cursor;
  const activeHasMore = cursor === undefined ? thread?.hasMoreBefore === true : hasMore;

  function loadOlder() {
    if (
      !live ||
      thread === undefined ||
      loading ||
      !activeHasMore ||
      activeCursor === null
    ) {
      return;
    }

    setLoading(true);
    setError(undefined);

    void readMessages(thread.id, { before: activeCursor, limit: 30 })
      .then((page) => {
        if (threadRef.current !== thread.id) {
          return;
        }

        const older = page.messages.map(messageToTranscript);
        setMessages((previous) => {
          const seen = new Set(previous.map((message) => message.id));
          const fresh = older.filter((message) => !seen.has(message.id));

          return [...fresh, ...previous];
        });
        setCursor(page.beforeCursor);
        setHasMore(page.hasMoreBefore);
      })
      .catch(() => {
        if (threadRef.current === thread.id) {
          setError(ERROR_COPY);
        }
      })
      .finally(() => {
        if (threadRef.current === thread.id) {
          setLoading(false);
        }
      });
  }

  return { messages, hasMore: live && activeHasMore, loading, error, loadOlder };
}
