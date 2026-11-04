'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Inline } from '../ui/stack';
import { ArrowUpIcon, ChevronRightIcon, DocumentIcon, PaperclipIcon } from '../ui/icons';
import { formatCount, type PreviewMessage, type PreviewRun, type PreviewThread } from '../../lib/preview-data';
import { ARRIVE_SPRING } from '../../lib/motion';

const MAX_LENGTH = 4_000;

interface LocalMessage {
  readonly id: string;
  readonly role: 'user';
  readonly at: string;
  readonly paragraphs: readonly string[];
}

export interface ThreadConversationProps {
  readonly botName: string;
  readonly thread: PreviewThread;
  /** Present only when the thread has an attachment, so a citation has a target. */
  readonly documentHref?: string | undefined;
}

/**
 * The conversation pane: transcript, run detail, and composer.
 *
 * Only the composer is stateful. The transcript is sample content; sending adds
 * a message to this browser tab and says so. Nothing is posted, no run is
 * queued, and the notice under the field never pretends otherwise.
 */
export function ThreadConversation({ botName, thread, documentHref }: Readonly<ThreadConversationProps>) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState<readonly LocalMessage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();

  /* A thread opens at its latest message, not at its first. Only the desktop
   * pane has its own scroll area; on a phone the page scrolls and the reader
   * starts at the header, which is what they expect there. */
  useEffect(() => {
    const scroller = scrollerRef.current;

    if (scroller !== null && scroller.scrollHeight > scroller.clientHeight) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [thread.id]);

  function grow() {
    const field = textareaRef.current;

    if (field === null) {
      return;
    }

    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
  }

  function send() {
    const text = draft.trim();

    if (text === '') {
      return;
    }

    setAdded((previous) => [
      ...previous,
      {
        id: `local-${previous.length + 1}`,
        role: 'user',
        at: 'now',
        paragraphs: [text],
      },
    ]);
    setDraft('');
    setNotice('Added to this thread locally. No run is dispatched in this preview.');
    window.requestAnimationFrame(() => {
      grow();
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight });
      textareaRef.current?.focus();
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  const messages = [
    ...thread.messages.map((message) => ({ kind: 'sample' as const, message })),
    ...added.map((message) => ({ kind: 'local' as const, message })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <ol className="mx-auto flex w-full max-w-reading flex-col gap-6 px-4 py-6 lg:px-6 lg:py-8">
          {messages.map(({ kind, message }) =>
            kind === 'sample' ? (
              <SampleMessage
                key={message.id}
                message={message}
                botName={botName}
                documentHref={documentHref}
              />
            ) : (
              <LocalTurn key={message.id} message={message} />
            ),
          )}
        </ol>
      </div>

      <div className="sticky bottom-0 z-10 border-t border-line bg-canvas px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:px-6">
        <form className="mx-auto w-full max-w-reading" onSubmit={onSubmit}>
          <label htmlFor="composer" className="sr-only">
            Write a message to {botName}
          </label>

          <div className="flex items-end gap-1.5 rounded-sm border border-line-strong bg-surface py-1 pr-1 pl-2.5 transition-colors duration-[var(--habi-duration-fast)] focus-within:border-accent">
            <button
              type="button"
              disabled
              aria-label="Attach a document — not available in this preview"
              className="grid size-11 shrink-0 place-items-center rounded-sm text-subtle disabled:cursor-not-allowed"
            >
              <PaperclipIcon size={16} />
            </button>

            <textarea
              ref={textareaRef}
              id="composer"
              name="message"
              rows={1}
              maxLength={MAX_LENGTH}
              placeholder={`Write to ${botName}…`}
              aria-describedby="composer-status"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                grow();
              }}
              onKeyDown={onKeyDown}
              className="max-h-40 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent py-2.5 text-base leading-relaxed text-ink placeholder:text-subtle focus:outline-none"
            />

            <motion.div
              whileTap={{ scale: reduceMotion === true ? 1 : 0.94 }}
              className="shrink-0"
            >
              <Button
                type="submit"
                aria-label="Send message"
                disabled={draft.trim() === ''}
                className="size-11 px-0"
              >
                <ArrowUpIcon size={16} />
              </Button>
            </motion.div>
          </div>

          <Inline gap={3} justify="between" className="mt-1.5 text-xs text-muted">
            <p id="composer-status" role="status" aria-live="polite" className="min-h-4">
              {notice === '' ? (
                <span className="hidden sm:inline">Enter sends · Shift + Enter adds a line</span>
              ) : (
                notice
              )}
            </p>
            <span aria-hidden="true" className="u-figures shrink-0 text-subtle">
              {draft.length} / {formatCount(MAX_LENGTH)}
            </span>
          </Inline>
        </form>
      </div>
    </div>
  );
}

function SampleMessage({
  message,
  botName,
  documentHref,
}: Readonly<{
  message: PreviewMessage;
  botName: string;
  documentHref: string | undefined;
}>) {
  const isUser = message.role === 'user';

  const reduceMotion = useReducedMotion();

  return (
    <li className={isUser ? 'flex justify-end' : ''}>
      <div className={isUser ? 'w-full max-w-[46ch]' : 'w-full max-w-[58ch]'}>
        <div
          className={[
            'rounded-sm border px-4 py-3',
            isUser ? 'border-accent-line bg-accent-soft' : 'border-line bg-surface',
          ].join(' ')}
        >
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-2xs text-subtle">
            <span className="u-label text-subtle">{isUser ? 'You' : botName}</span>
            <span className="u-figures">{message.at}</span>
          </p>

          <div className="space-y-2.5 text-sm leading-relaxed text-ink">
            {message.paragraphs.map((paragraph, index) => (
              <p key={index}>
                {paragraph}
                {message.streaming === true && index === message.paragraphs.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-[0.12em] bg-signal align-baseline"
                  >
                    <motion.span
                      className="block h-full w-full bg-signal"
                      animate={reduceMotion === true ? { opacity: 1 } : { opacity: [1, 0.12, 1] }}
                      transition={
                        reduceMotion === true
                          ? { duration: 0 }
                          : { duration: 1.1, repeat: Infinity, ease: 'linear' }
                      }
                    />
                  </span>
                ) : null}
              </p>
            ))}
          </div>

          {message.citation === undefined || documentHref === undefined ? null : (
            <a
              href={`${documentHref}#${message.citation.anchor}`}
              className="mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-xs border border-signal-line bg-signal-soft px-2 text-2xs font-semibold text-signal-ink hover:border-signal"
            >
              <DocumentIcon size={12} />
              {message.citation.label}
              <ChevronRightIcon size={10} />
            </a>
          )}
        </div>

        {message.run === undefined ? null : <RunStrip run={message.run} />}
      </div>
    </li>
  );
}

function LocalTurn({ message }: Readonly<{ message: LocalMessage }>) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.li
      initial={reduceMotion === true ? false : { opacity: 0, y: 10, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={reduceMotion === true ? { duration: 0 } : ARRIVE_SPRING}
      className="flex justify-end"
    >
      <div className="w-full max-w-[58ch]">
        <div className="rounded-sm border border-accent-line bg-accent-soft px-4 py-3">
          <p className="mb-2 flex flex-wrap items-baseline gap-x-2 text-2xs text-subtle">
            <span className="u-label text-subtle">You</span>
            <span className="u-figures">{message.at}</span>
          </p>
          <p className="text-sm leading-relaxed text-ink">{message.paragraphs[0]}</p>
        </div>
        <p className="mt-1.5 text-2xs text-subtle">Local only · not sent</p>
      </div>
    </motion.li>
  );
}

/**
 * Run detail as a native disclosure: no script, keyboard-operable, and the
 * summary always shows the figures that answer "what did it cost, and did it
 * use anything?".
 */
function RunStrip({ run }: Readonly<{ run: PreviewRun }>) {
  const live = run.state === 'streaming';

  return (
    <details className="group mt-2">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-2xs text-muted">
        <ChevronRightIcon
          size={12}
          className="shrink-0 transition-transform duration-[var(--habi-duration-fast)] ease-standard group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="u-figures font-semibold text-ink">run {run.id}</span>
        <Badge tone={live ? 'signal' : 'neutral'} dot={live}>
          {run.state}
        </Badge>
        <span className="u-figures">
          {formatCount(run.inTokens)} in · {formatCount(run.outTokens)} out
        </span>
        <span className="u-figures ml-auto">tools 0</span>
      </summary>

      <ol className="border border-t-0 border-line bg-surface px-2.5 py-1">
        {run.events.map((event) => (
          <li
            key={event.seq}
            className="u-figures grid grid-cols-[4.25rem_minmax(0,1fr)_auto] gap-2 border-b border-line py-1.5 text-2xs text-muted last:border-b-0"
          >
            <span>{event.at}</span>
            <span className="text-ink">{event.label}</span>
            <span>seq {event.seq}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
