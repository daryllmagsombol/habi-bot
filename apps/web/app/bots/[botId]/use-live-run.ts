'use client';

/**
 * The live conversation coordinator for one thread.
 *
 * It owns sending, the optimistic turns, the Run event stream, reconnect, and
 * cancel. The route renders the result; no component fetches anything.
 *
 * Failure is never optimistic: a failed send removes its placeholder and puts
 * the text back in the field, and a failed stream keeps the last committed text
 * and says the connection is retrying. Terminal events reload the persisted
 * transcript; if that reload fails the streamed text stays and is labelled as
 * stream-derived.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunView, TranscriptMessage } from '../../../components/threads';
import {
  ChatRequestError,
  cancelRun,
  chatErrorMessage,
  postMessage,
  readCsrfToken,
  readMessages,
  subscribeRun,
  type RunStreamHandle,
} from '../../../lib/api/browser';
import { formatClock, paragraphsOf } from '../../../lib/api/format';
import type { RunEventDto } from '../../../lib/api/types';
import { messageToTranscript, runDtoToRunView } from './api-data';

export type LivePhase =
  | 'idle'
  | 'sending'
  | 'waiting'
  | 'streaming'
  | 'complete'
  | 'stopped'
  | 'failed'
  | 'error';

export interface LiveRun {
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly extra: readonly TranscriptMessage[];
  readonly messages: readonly TranscriptMessage[] | undefined;
  readonly run: RunView | undefined;
  readonly phase: LivePhase;
  readonly error: string | undefined;
  readonly info: string | undefined;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly send: (text: string) => void;
  readonly cancel: () => void;
  readonly retry: () => void;
  /** Clears this tab's interaction state; refreshed messages survive by default. */
  readonly reset: (keepMessages?: boolean) => void;
}

const MAX_RECONNECTS = 4;
const TERMINAL_EVENTS = new Set(['run.completed', 'run.failed', 'run.cancelled']);

function eventDetail(event: RunEventDto): string {
  if (event.type === 'message.delta') {
    const text = event.payload.text;
    return `+${typeof text === 'string' ? text.length : 0} chars`;
  }

  if (event.type === 'usage.recorded') {
    const total = event.payload.totalTokens;
    return typeof total === 'number' ? `${total} tok` : 'usage unknown';
  }

  if (TERMINAL_EVENTS.has(event.type)) {
    const errorCode = event.payload.errorCode;
    return typeof errorCode === 'string' ? errorCode : 'terminal';
  }

  return '';
}

function toEventView(event: RunEventDto) {
  const detail = eventDetail(event);

  return {
    at: formatClock(event.createdAt),
    label: detail.length === 0 ? event.type : `${event.type} · ${detail}`,
    seq: event.seq,
  };
}

function appendText(previous: string, delta: string): string {
  return `${previous}${delta}`;
}

export function useLiveRun(
  threadId: string | undefined,
  enabled: boolean,
): LiveRun {
  const [draft, setDraft] = useState('');
  const [extra, setExtra] = useState<readonly TranscriptMessage[]>([]);
  const [messages, setMessages] = useState<readonly TranscriptMessage[] | undefined>(undefined);
  const [run, setRun] = useState<RunView | undefined>(undefined);
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [error, setError] = useState<string | undefined>(undefined);
  const [info, setInfo] = useState<string | undefined>(undefined);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [retryText, setRetryText] = useState<string | undefined>(undefined);

  const streamRef = useRef<RunStreamHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = useRef(0);
  const terminalRef = useRef(false);
  const closedRef = useRef(false);
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const runIdRef = useRef<string | undefined>(undefined);
  const assistantIdRef = useRef<string | undefined>(undefined);
  const streamTextRef = useRef('');
  const runRef = useRef<RunView | undefined>(undefined);
  const pendingRef = useRef<{ readonly text: string; readonly id: string } | undefined>(
    undefined,
  );
  const connectRef = useRef<(id: string) => void>(() => {});
  const mountedRef = useRef(true);
  const threadRef = useRef(threadId);

  useEffect(() => {
    threadRef.current = threadId;
  }, [threadId]);

  const stopTimers = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopStream = useCallback(() => {
    streamRef.current?.abort();
    streamRef.current = null;
  }, []);

  const reset = useCallback((keepMessages = false) => {
    stopTimers();
    stopStream();
    attemptsRef.current = 0;
    terminalRef.current = false;
    lastEventIdRef.current = undefined;
    runIdRef.current = undefined;
    assistantIdRef.current = undefined;
    streamTextRef.current = '';
    runRef.current = undefined;
    pendingRef.current = undefined;
    setDraft('');
    setExtra([]);
    if (!keepMessages) {
      setMessages(undefined);
    }
    setRun(undefined);
    setPhase('idle');
    setError(undefined);
    setInfo(undefined);
    setRunId(undefined);
    setRetryText(undefined);
  }, [stopStream, stopTimers]);

  const refresh = useCallback(async (id: string) => {
    if (id.length === 0) {
      return;
    }

    try {
      const page = await readMessages(id);

      if (!mountedRef.current || threadRef.current !== id) {
        return;
      }

      const mapped = page.messages.map(messageToTranscript);
      const last = mapped.at(-1);

      // The API does not link messages to Runs; this tab does know the Run it
      // just watched, so the strip stays attached to the reply it produced.
      if (last !== undefined && last.variant === 'bot' && runRef.current !== undefined) {
        mapped[mapped.length - 1] = { ...last, run: runRef.current };
      }

      setMessages(mapped);
      setExtra([]);
    } catch {
      if (mountedRef.current) {
        setInfo(
          'The run finished, but the saved transcript could not be reloaded. What you see came from the event stream.',
        );
      }
    }
  }, []);

  const finish = useCallback(
    (type: string) => {
      terminalRef.current = true;
      stopTimers();
      stopStream();

      const nextPhase: LivePhase =
        type === 'run.completed' ? 'complete' : type === 'run.cancelled' ? 'stopped' : 'failed';
      const nextState =
        type === 'run.completed' ? 'complete' : type === 'run.cancelled' ? 'stopped' : 'failed';

      setPhase(nextPhase);
      setError(undefined);
      setInfo(
        type === 'run.completed'
          ? 'Reply complete.'
          : type === 'run.cancelled'
            ? 'The run was stopped. The reply does not continue.'
            : 'The run failed. The transcript keeps whatever arrived before the failure.',
      );
      setExtra((previous) =>
        previous.map((turn) =>
          turn.id === assistantIdRef.current
            ? {
                ...turn,
                state: 'complete',
                run:
                  runRef.current === undefined
                    ? turn.run
                    : { ...runRef.current, state: nextState },
              }
            : turn,
        ),
      );
      runRef.current =
        runRef.current === undefined
          ? undefined
          : { ...runRef.current, state: nextState };
      setRun(runRef.current);

      const id = threadRef.current;

      if (id !== undefined) {
        void refresh(id);
      }
    },
    [refresh, stopStream, stopTimers],
  );

  const handleEvent = useCallback(
    (event: RunEventDto, cursor: string | undefined) => {
      const resume = cursor !== undefined && cursor.length > 0 ? cursor : event.id;

      if (resume !== undefined && resume.length > 0) {
        lastEventIdRef.current = resume;
      }

      setRun((previous) => {
        const base =
          previous ??
          runDtoToRunView(
            {
              id: event.runId,
              conversationId: '',
              status: 'running',
              dispatchState: '',
              errorCode: null,
              lastEventSeq: event.seq,
              createdAt: event.createdAt,
              updatedAt: event.createdAt,
              startedAt: null,
              finishedAt: null,
              usage: {
                status: 'unknown',
                grossPromptTokens: null,
                grossCompletionTokens: null,
                cachedPromptTokens: null,
                reasoningTokens: null,
                totalTokens: null,
                costStatus: 'unknown',
              },
            },
            [],
          );
        const next: RunView = {
          ...base,
          state:
            event.type === 'message.delta' && base.state !== 'complete'
              ? 'streaming'
              : base.state,
          events: [...base.events, toEventView(event)],
        };

        runRef.current = next;
        return next;
      });

      if (event.type === 'message.delta') {
        const text = event.payload.text;

        if (typeof text === 'string') {
          streamTextRef.current = appendText(streamTextRef.current, text);
          const paragraphs = paragraphsOf(streamTextRef.current);
          const assistantId = assistantIdRef.current;

          setExtra((previous) =>
            previous.map((turn) =>
              turn.id === assistantId ? { ...turn, paragraphs } : turn,
            ),
          );
          setPhase('streaming');
          setInfo('The reply is streaming.');
        }
      }

      if (event.type === 'usage.recorded') {
        const prompt = event.payload.grossPromptTokens;
        const completion = event.payload.grossCompletionTokens;
        const promptTokens = typeof prompt === 'number' ? prompt : undefined;
        const completionTokens = typeof completion === 'number' ? completion : undefined;

        if (promptTokens !== undefined || completionTokens !== undefined) {
          setRun((previous) => {
            if (previous === undefined) {
              return previous;
            }

            const next: RunView = {
              ...previous,
              tokensKnown: true,
              inTokens: promptTokens ?? previous.inTokens,
              outTokens: completionTokens ?? previous.outTokens,
            };

            runRef.current = next;
            return next;
          });
        }
      }

      if (event.type === 'message.completed') {
        const text = event.payload.text;

        if (typeof text === 'string' && text.length > 0) {
          streamTextRef.current = text;
          const paragraphs = paragraphsOf(text);
          const assistantId = assistantIdRef.current;

          setExtra((previous) =>
            previous.map((turn) =>
              turn.id === assistantId ? { ...turn, paragraphs, state: 'complete' } : turn,
            ),
          );
        }
      }

      if (TERMINAL_EVENTS.has(event.type)) {
        finish(event.type);
      }
    },
    [finish],
  );

  const connect = useCallback(
    (id: string) => {
      if (!mountedRef.current) {
        return;
      }

      stopStream();
      closedRef.current = false;

      streamRef.current = subscribeRun(
        id,
        lastEventIdRef.current,
        {
          onEvent: handleEvent,
          onGap: (gap) => {
            setInfo(
              `Part of the event log was not retained (seq ${gap.fromSeq}–${gap.toSeq}). The reply may be incomplete.`,
            );
          },
        },
        (reason, status) => {
          streamRef.current = null;

          if (closedRef.current || terminalRef.current || reason === 'aborted') {
            return;
          }

          if (status === 401) {
            setPhase('error');
            setError(
              'Your session has ended, so the run stream cannot continue. Sign in again to reopen this thread.',
            );
            return;
          }

          attemptsRef.current += 1;

          if (attemptsRef.current > MAX_RECONNECTS) {
            setPhase('error');
            setError(
              'The run stream stopped and could not be resumed. Retry to reconnect with the last sequence this tab saw.',
            );
            return;
          }

          const delay = 400 * 2 ** (attemptsRef.current - 1);
          setInfo('The run stream dropped. Reconnecting with the last sequence…');
          timerRef.current = setTimeout(() => connectRef.current(id), delay);
        },
      );
    },
    [handleEvent, stopStream],
  );

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    mountedRef.current = true;
    closedRef.current = false;

    return () => {
      mountedRef.current = false;
      closedRef.current = true;
      stopTimers();
      stopStream();
    };
  }, [stopStream, stopTimers]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();

      if (!enabled || threadId === undefined || content.length === 0) {
        return;
      }

      const csrfToken = readCsrfToken();
      const pending = pendingRef.current;

      if (csrfToken === undefined) {
        setError(
          'This session did not publish a CSRF token, so nothing was sent. Sign in again through the identity screens, then retry.',
        );
        setPhase('error');
        setRetryText(content);
        return;
      }

      reset(true);
      setDraft('');
      setPhase('sending');
      setInfo('Sending the message…');

      const localUserId = `local-user-${Date.now()}`;
      const assistantId = `local-bot-${Date.now()}`;
      const clientMessageId =
        pending !== undefined && pending.text === content ? pending.id : crypto.randomUUID();

      pendingRef.current = { text: content, id: clientMessageId };
      assistantIdRef.current = assistantId;
      streamTextRef.current = '';

      setExtra([
        {
          id: localUserId,
          variant: 'user',
          at: 'now',
          paragraphs: [content],
        },
      ]);

      let result;

      try {
        result = await postMessage(
          threadId,
          content,
          clientMessageId,
          csrfToken,
        );
      } catch (error_) {
        if (!mountedRef.current) {
          return;
        }

        setExtra([]);
        setDraft(content);
        setPhase('error');
        setRetryText(content);
        setError(chatErrorMessage(error_));
        setInfo(undefined);
        return;
      }

      if (!mountedRef.current || threadRef.current !== threadId) {
        return;
      }

      const mappedUser = messageToTranscript(result.message);
      const runView = runDtoToRunView(result.run);

      runRef.current = runView;
      runIdRef.current = result.runId;
      pendingRef.current = undefined;
      lastEventIdRef.current = undefined;
      attemptsRef.current = 0;
      terminalRef.current = false;
      setRun(runView);
      setRunId(result.runId);
      setRetryText(undefined);
      setError(undefined);
      setExtra([
        mappedUser,
        {
          id: assistantId,
          variant: 'bot',
          at: 'now',
          paragraphs: [],
          state: 'streaming',
          run: runView,
        },
      ]);
      setPhase(runView.state === 'queued' ? 'waiting' : 'streaming');
      setInfo(
        runView.state === 'queued'
          ? 'Message saved. The run is queued; a reply appears when the worker writes events.'
          : 'Message saved. Waiting for the reply.',
      );
      connect(result.runId);
    },
    [connect, enabled, reset, threadId],
  );

  const cancel = useCallback(async () => {
    const id = runIdRef.current;

    if (id === undefined) {
      return;
    }

    const csrfToken = readCsrfToken();

    if (csrfToken === undefined) {
      setError(
        'This session did not publish a CSRF token, so the run cannot be cancelled from here.',
      );
      return;
    }

    try {
      const result = await cancelRun(id, csrfToken);

      if (!mountedRef.current) {
        return;
      }

      terminalRef.current = true;
      closedRef.current = true;
      stopTimers();
      stopStream();

      const cancelled = runDtoToRunView(result.run, runRef.current?.events ?? []);
      runRef.current = cancelled;
      setRun(cancelled);
      setPhase('stopped');
      setError(undefined);
      setInfo(
        result.run.status === 'cancelled'
          ? 'Run stopped before it was dispatched. The reply will not continue.'
          : 'The run is already terminal; it was not changed.',
      );
      setExtra((previous) =>
        previous.map((turn) =>
          turn.id === assistantIdRef.current
            ? { ...turn, state: 'complete', run: cancelled }
            : turn,
        ),
      );
    } catch (error_) {
      if (!mountedRef.current) {
        return;
      }

      // `cancel_unavailable` means the run may already have executed. Keep the
      // live state; never relabel it stopped locally.
      setError(
        error_ instanceof ChatRequestError && error_.code === 'cancel_unavailable'
          ? 'This run may already have executed, so it was not relabelled. Nothing was cancelled.'
          : chatErrorMessage(error_),
      );
    }
  }, [stopStream, stopTimers]);

  const retry = useCallback(() => {
    setError(undefined);

    if (retryText !== undefined && retryText.length > 0) {
      void send(retryText);
      return;
    }

    const id = runIdRef.current;

    if (id !== undefined) {
      attemptsRef.current = 0;
      setPhase('waiting');
      setInfo('Reconnecting to the run stream…');
      connect(id);
    }
  }, [connect, retryText, send]);

  const canCancel =
    runId !== undefined &&
    phase !== 'complete' &&
    phase !== 'stopped' &&
    phase !== 'failed';

  return {
    draft,
    setDraft,
    extra,
    messages,
    run,
    phase,
    error,
    info,
    canCancel,
    canRetry: phase === 'error' || (error !== undefined && retryText !== undefined),
    send: (text: string) => {
      void send(text);
    },
    cancel: () => {
      void cancel();
    },
    retry,
    reset,
  };
}
