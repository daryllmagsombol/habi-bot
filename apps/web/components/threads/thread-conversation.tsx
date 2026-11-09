'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar, Button, ChevronRightIcon, DocumentIcon } from '../ui';
import { Composer } from './composer';
import type { ComposerStatus } from './composer';
import { MessageBubble } from './message-bubble';
import { RunStrip } from './run-strip';
import { ThreadCard } from './thread-card';
import type { RunView, ThreadView, TranscriptMessage } from './types';

export interface TranscriptPagination {
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly onLoadOlder: () => void;
  readonly error?: string | undefined;
}

export interface ThreadConversationProps {
  readonly bot: { readonly name: string; readonly initials: string };
  readonly owner: { readonly name: string; readonly initials: string };
  readonly thread: ThreadView;
  readonly headingId?: string | undefined;
  /** Guidance shown under the field until something is sent. */
  readonly hint: ReactNode;
  /** Replaces the hint after an optimistic send. */
  readonly sendNotice: string;
  /** The note under a locally added turn. */
  readonly localFootnote: string;
  /**
   * A parent-owned send. When present the route owns the optimistic turn and
   * reconciliation; the component only reports the text and clears the field.
   */
  readonly onSend?: ((text: string) => void) | undefined;
  /** Controlled draft, for a parent that restores text after a failed send. */
  readonly draft?: string | undefined;
  readonly onDraftChange?: ((value: string) => void) | undefined;
  /** Sending, offline, or error state from the route. */
  readonly composerStatus?: ComposerStatus | undefined;
  /** A leading composer control, typically a disabled attach button. */
  readonly attachment?: ReactNode;
  readonly maxLength?: number;
  /** Textarea id; must be unique if two conversations share a page. */
  readonly composerId?: string;
  /** Older-message paging; absent when the transcript is complete. */
  readonly pagination?: TranscriptPagination | undefined;
}

/**
 * The transcript and the composer, wired to one thread.
 *
 * Only the draft and the optimistic turn are local state. The turns themselves
 * arrive through props; sending appends a turn to this tab and says so. A real
 * send would replace this append with the server's message, keeping the same
 * bubbles, run strip and composer.
 *
 * Loading older messages is a parent call; this component captures the document
 * height before it and restores the reading position after the new top rows
 * arrive, so a long transcript does not jump and a live stream keeps its place.
 */
export function ThreadConversation({
  bot,
  owner,
  thread,
  headingId,
  hint,
  sendNotice,
  localFootnote,
  onSend,
  draft: controlledDraft,
  onDraftChange,
  composerStatus,
  attachment,
  maxLength = 4_000,
  composerId = 'composer',
  pagination,
}: Readonly<ThreadConversationProps>) {
  const [localDraft, setLocalDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [added, setAdded] = useState<readonly TranscriptMessage[]>([]);
  const listRef = useRef<HTMLOListElement>(null);
  const olderAnchorRef = useRef<{ readonly height: number; readonly top: number } | undefined>(
    undefined,
  );
  const messageCountRef = useRef(thread.messages.length);
  const draft = controlledDraft ?? localDraft;

  const setDraft = (value: string) => {
    if (onDraftChange === undefined) {
      setLocalDraft(value);
    }

    onDraftChange?.(value);
  };

  const run: RunView | undefined = thread.messages.findLast(
    (message) => message.run !== undefined,
  )?.run;

  useEffect(() => {
    if (added.length === 0) {
      return;
    }

    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [added.length]);

  useEffect(() => {
    const previous = messageCountRef.current;
    messageCountRef.current = thread.messages.length;

    const anchor = olderAnchorRef.current;

    if (anchor === undefined || thread.messages.length <= previous) {
      return;
    }

    olderAnchorRef.current = undefined;
    const delta = document.documentElement.scrollHeight - anchor.height;

    if (delta > 0) {
      window.scrollTo({ top: anchor.top + delta });
    }
  }, [thread.messages.length]);

  function loadOlder() {
    olderAnchorRef.current = {
      height: document.documentElement.scrollHeight,
      top: window.scrollY,
    };
    pagination?.onLoadOlder();
  }

  function send() {
    const text = draft.trim();

    if (text === '') {
      return;
    }

    setDraft('');

    if (onSend !== undefined) {
      onSend(text);
      return;
    }

    setAdded((previous) => [
      ...previous,
      {
        id: `local-${previous.length + 1}`,
        variant: 'user',
        at: 'now',
        paragraphs: [text],
      },
    ]);
    setNotice(sendNotice);
  }

  const userAvatar = (
    <Avatar name={owner.name} initials={owner.initials} tone="user" size="xs" />
  );
  const botAvatar = <Avatar name={bot.name} initials={bot.initials} tone="neutral" size="xs" />;

  return (
    <ThreadCard
      title={thread.title}
      headingId={headingId}
      metaItems={thread.metaItems}
      transcript={
        <div className="flex flex-col gap-4">
          {pagination === undefined ? null : (
            <div className="flex flex-wrap items-center gap-2 border-b border-line-soft pb-3">
              {pagination.hasMore ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={pagination.loading}
                  onClick={loadOlder}
                >
                  Load older messages
                </Button>
              ) : (
                <p className="text-2xs text-subtle">The start of this thread.</p>
              )}
              {pagination.error === undefined ? null : (
                <p role="alert" className="text-2xs text-danger">
                  {pagination.error}
                </p>
              )}
            </div>
          )}

          <ol ref={listRef} className="flex flex-col gap-4">
            {thread.messages.map((message) => (
              <MessageBubble
                key={message.id}
                variant={message.variant}
                name={message.variant === 'user' ? owner.name : bot.name}
                at={message.at}
                avatar={message.variant === 'user' ? userAvatar : botAvatar}
                paragraphs={message.paragraphs}
                state={message.state}
                citation={
                  message.citation === undefined ? undefined : (
                    <a
                      href={message.citation.href}
                      className="mt-1.5 inline-flex min-h-11 items-center gap-1.5 rounded-sm text-2xs font-medium text-accent-ink underline decoration-accent-line decoration-1 underline-offset-4 hover:no-underline"
                    >
                      <DocumentIcon size={12} />
                      {message.citation.label}
                      <ChevronRightIcon size={10} />
                    </a>
                  )
                }
              />
            ))}

            {added.map((message) => (
              <MessageBubble
                key={message.id}
                variant={message.variant}
                name={owner.name}
                at={message.at}
                avatar={userAvatar}
                paragraphs={message.paragraphs}
                footnote={<p className="mt-1 text-2xs text-subtle">{localFootnote}</p>}
              />
            ))}
          </ol>
        </div>
      }
      runStrip={
        run === undefined ? undefined : <RunStrip run={run} />
      }
      composer={
        <Composer
          id={composerId}
          label={`Write a message to ${bot.name}`}
          value={draft}
          onValueChange={setDraft}
          onSend={send}
          hint={notice === '' ? hint : notice}
          counter={{ current: draft.length, max: maxLength }}
          maxLength={maxLength}
          status={composerStatus}
          attachment={attachment}
        />
      }
    />
  );
}
