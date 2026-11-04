'use client';

import Link from 'next/link';
import type { MouseEvent } from 'react';
import { BotMark } from '../bot-mark';
import { Badge } from '../ui/badge';
import { formatCount, type PreviewBot } from '../../lib/preview-data';
import { threadHref } from '../../lib/links';

export interface ThreadRailProps {
  readonly bot: PreviewBot;
  readonly activeThreadId: string;
  /** On a phone the rail is the list view; it disappears once a thread is open. */
  readonly hiddenOnMobile: boolean;
  /** In-place selection; modified clicks still open the thread in a new tab. */
  readonly onSelectThread?: (threadId: string) => void;
}

/**
 * The left pane: who this Bot is, then its conversations newest first.
 *
 * A thread row carries three facts and no more — title, when, and what the
 * conversation has cost so far. The row is a link, so the list is navigable
 * with the keyboard, opens in a new tab, and survives a reload.
 */
export function ThreadRail({
  bot,
  activeThreadId,
  hiddenOnMobile,
  onSelectThread,
}: Readonly<ThreadRailProps>) {
  const approved = approvedCount(bot);

  function select(event: MouseEvent<HTMLAnchorElement>, threadId: string) {
    if (onSelectThread === undefined) {
      return;
    }

    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    onSelectThread(threadId);
  }

  return (
    <aside
      aria-label={`${bot.name} threads`}
      className={[
        'border-line bg-surface lg:flex lg:min-h-0 lg:flex-col lg:border-r',
        hiddenOnMobile ? 'max-lg:hidden' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="border-b border-line px-4 py-4 lg:shrink-0 lg:px-6">
        <div className="flex items-center gap-3">
          <BotMark bot={bot} size="sm" />
          <p className="min-w-0 text-base leading-snug font-semibold tracking-heading text-ink">{bot.name}</p>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">{bot.purpose}</p>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <dt className="u-label text-subtle">Threads</dt>
            <dd className="u-figures mt-1 text-sm text-ink">{bot.threads.length}</dd>
          </div>
          <div>
            <dt className="u-label text-subtle">Memories</dt>
            <dd className="u-figures mt-1 text-sm text-ink">
              {approved} of {bot.memories.length}
            </dd>
          </div>
        </dl>
      </div>

      <nav
        aria-label="Threads"
        className="border-t border-line lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
      >
        <ul>
          {bot.threads.map((thread) => {
            const current = thread.id === activeThreadId;
            const last = thread.messages.at(-1);
            const live = last?.streaming === true;

            return (
              <li key={thread.id} className="border-b border-line">
                <Link
                  href={threadHref(bot.id, thread.id)}
                  aria-current={current ? 'page' : undefined}
                  onClick={(event) => select(event, thread.id)}
                  className={[
                    'block px-4 py-3 transition-colors duration-[var(--habi-duration-fast)] ease-standard lg:px-6',
                    current ? 'bg-accent-soft' : 'hover:bg-sunken',
                  ].join(' ')}
                >
                  <span className="flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-sm leading-snug font-medium text-ink">
                      {thread.title}
                    </span>
                    {live ? (
                      <Badge tone="signal" dot>
                        live
                      </Badge>
                    ) : null}
                  </span>
                  <span className="u-figures mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
                    <span>{thread.at}</span>
                    <span aria-hidden="true">·</span>
                    <span>{thread.messages.length} messages</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatCount(thread.tokens)} tok</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line px-4 py-3 text-xs leading-relaxed text-muted lg:shrink-0 lg:px-6">
        <p>Both this Bot and the conversation approve a memory before a run can recall it.</p>
        <p className="mt-1.5 text-subtle">No tools. The allow-list is empty. Sample data — nothing is saved.</p>
      </div>
    </aside>
  );
}

function approvedCount(bot: PreviewBot): number {
  return bot.memories.filter((memory) => memory.botApproved && memory.threadApproved).length;
}
