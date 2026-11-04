import type { Metadata } from 'next';
import { AppBar } from '../../components/app-bar';
import { ThreadRow } from '../../components/threads';
import { Badge, Button, EmptyState, MetaRow, SkipLink } from '../../components/ui';
import {
  formatCount,
  previewAllowance,
  previewBots,
  shortWhen,
  totalThreadCount,
  type PreviewThread,
} from '../../lib/preview-data';
import { threadHref } from '../../lib/links';
import { readApiConfig } from '../../lib/api/config';
import { countLabel, shortWhen as shortWhenIso } from '../../lib/api/format';
import { callerCookieHeader, fetchBots, fetchThreads } from '../../lib/api/server';
import type { ApiFailure } from '../../lib/api/server';
import type { BotSummaryDto, ConversationDto } from '../../lib/api/types';
import { DataStatePage } from '../data-state';

export async function generateMetadata(): Promise<Metadata> {
  if (readApiConfig().kind !== 'unset') {
    return {
      title: 'Threads',
      description: 'Conversations from the Habi chat API, grouped by Bot.',
    };
  }

  return {
    title: 'Threads',
    description: 'Every sample thread in the Habi interface preview, grouped by Bot.',
  };
}

/** The API configuration and cookie are request-scoped, not build-scoped. */
export const dynamic = 'force-dynamic';

interface PreviewRow {
  readonly thread: PreviewThread;
  readonly botName: string;
}

const PREVIEW_COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

const PREVIEW_ROWS: readonly PreviewRow[] = previewBots.flatMap((bot) =>
  bot.threads.map((thread) => ({ thread, botName: bot.name })),
);

interface LiveRow {
  readonly thread: ConversationDto;
  readonly bot: BotSummaryDto;
}

function firstFailure(
  results: readonly (
    | { readonly ok: true; readonly data: unknown }
    | ApiFailure
  )[],
): ApiFailure | undefined {
  return results.find((result): result is ApiFailure => !result.ok);
}

/**
 * All threads, in the order the API lists them per Bot.
 *
 * The list is not a second workspace: every row is a real link into the thread.
 * The rows and their meta use the same primitives as the thread card, so the
 * two screens cannot drift apart.
 */
export default async function ThreadsPage() {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return (
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <AppBar section="threads" counts={PREVIEW_COUNTS} allowance={previewAllowance} />

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-wide flex-1 px-4 pb-16 focus:outline-none sm:px-6 lg:pb-20"
        >
          <header className="pt-6 pb-6 sm:pt-9 sm:pb-7">
            <h1 className="text-page tracking-display text-ink">Threads</h1>
            <p className="mt-2.5 max-w-[46ch] text-sm leading-normal text-subtle sm:text-sm">
              Every conversation is bound to a single bot and its own memory gates. Open one to read
              the transcript, the run, and the document behind a reply.
            </p>
          </header>

          <nav aria-label="All threads">
            <ul className="border-t border-line">
              {PREVIEW_ROWS.map(({ thread, botName }) => {
                const live = thread.messages.at(-1)?.streaming === true;

                return (
                  <li key={`${thread.botId}-${thread.id}`} className="border-b border-line">
                    <ThreadRow
                      item={{
                        id: thread.id,
                        title: thread.title,
                        time: shortWhen(thread.at),
                        href: threadHref(thread.botId, thread.id),
                      }}
                      subtitle={`${botName} · ${thread.messages.length} messages`}
                      density="comfortable"
                      titleOverflow="truncate"
                      trailing={
                        <span className="flex shrink-0 items-center gap-3">
                          {live ? (
                            <Badge tone="accent" dot>
                              run live
                            </Badge>
                          ) : null}
                          <MetaRow
                            as="span"
                            variant="spaced"
                            className="text-2xs text-subtle"
                            items={[
                              {
                                key: 'tokens',
                                label: (
                                  <span className="u-figures max-sm:hidden">
                                    {formatCount(thread.tokens)} tok
                                  </span>
                                ),
                              },
                            ]}
                          />
                          <span className="u-figures w-9 text-right text-2xs text-subtle">
                            {shortWhen(thread.at)}
                          </span>
                        </span>
                      }
                    />
                  </li>
                );
              })}
            </ul>
          </nav>

          <p className="mt-10 max-w-[62ch] text-xs leading-relaxed text-subtle">
            Eight conversations across four bots, all local sample data. Nothing is saved, no model
            is called, and no run is dispatched from this preview.
          </p>
        </main>
      </div>
    );
  }

  if (config.kind === 'invalid') {
    return (
      <DataStatePage
        section="threads"
        failure={{ ok: false, reason: 'invalid_config', status: 0 }}
        retryHref="/threads"
      />
    );
  }

  const cookie = await callerCookieHeader();
  const botsResult = await fetchBots(cookie);

  if (!botsResult.ok) {
    return <DataStatePage section="threads" failure={botsResult} retryHref="/threads" />;
  }

  const bots = botsResult.data.bots;
  const threadResults = await Promise.all(
    bots.map(async (bot) => ({ bot, result: await fetchThreads(bot.id, cookie) })),
  );
  const failure = firstFailure(threadResults.map((entry) => entry.result));

  if (failure !== undefined) {
    return <DataStatePage section="threads" failure={failure} retryHref="/threads" />;
  }

  const rows: readonly LiveRow[] = threadResults.flatMap(({ bot, result }) =>
    result.ok ? result.data.threads.map((thread) => ({ thread, bot })) : [],
  );

  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <AppBar
        section="threads"
        counts={{ bots: bots.length, threads: rows.length }}
        mode="live"
      />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-wide flex-1 px-4 pb-16 focus:outline-none sm:px-6 lg:pb-20"
      >
        <header className="pt-6 pb-6 sm:pt-9 sm:pb-7">
          <h1 className="text-page tracking-display text-ink">Threads</h1>
          <p className="mt-2.5 max-w-[52ch] text-sm leading-normal text-subtle sm:text-sm">
            Every conversation is bound to a single Bot. Open one to read the transcript and the run
            this tab starts. Run history and token counts are not exposed by this API yet.
          </p>
        </header>

        {rows.length === 0 ? (
          <EmptyState
            headingLevel={2}
            title="No threads yet"
            description="The API returned owned Bots with no conversations. Creating a thread is not exposed by this API yet, so this is the whole list."
            action={<Button disabled>New thread</Button>}
          />
        ) : (
          <nav aria-label="All threads">
            <ul className="border-t border-line">
              {rows.map(({ thread, bot }) => (
                <li key={thread.id} className="border-b border-line">
                  <ThreadRow
                    item={{
                      id: thread.id,
                      title: thread.title,
                      time: shortWhenIso(thread.updatedAt),
                      href: threadHref(bot.id, thread.id),
                    }}
                    subtitle={`${bot.name} · ${countLabel(thread.lastMessageSeq, 'message', 'messages')}`}
                    density="comfortable"
                    titleOverflow="truncate"
                    trailing={
                      <span className="flex shrink-0 items-center gap-3">
                        {thread.status === 'archived' ? (
                          <Badge tone="neutral">archived</Badge>
                        ) : null}
                        <span className="u-figures w-9 text-right text-2xs text-subtle">
                          {shortWhenIso(thread.updatedAt)}
                        </span>
                      </span>
                    }
                  />
                </li>
              ))}
            </ul>
          </nav>
        )}

        <p className="mt-10 max-w-[62ch] text-xs leading-relaxed text-subtle">
          {countLabel(rows.length, 'conversation', 'conversations')} across{' '}
          {countLabel(bots.length, 'Bot', 'Bots')}, read from the Habi API for your session. Nothing
          is replaced with sample data, and no token figure is invented.
        </p>
      </main>
    </div>
  );
}
