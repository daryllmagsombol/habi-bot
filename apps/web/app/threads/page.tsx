import type { Metadata } from 'next';
import { AppBar } from '../../components/app-bar';
import { ThreadRow } from '../../components/threads';
import { Badge, MetaRow, SkipLink } from '../../components/ui';
import {
  formatCount,
  previewAllowance,
  previewBots,
  shortWhen,
  totalThreadCount,
  type PreviewThread,
} from '../../lib/preview-data';
import { threadHref } from '../../lib/links';

export const metadata: Metadata = {
  title: 'Threads',
  description: 'Every sample thread in the Habi interface preview, grouped by Bot.',
};

interface Row {
  readonly thread: PreviewThread;
  readonly botName: string;
}

const COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

const ROWS: readonly Row[] = previewBots.flatMap((bot) =>
  bot.threads.map((thread) => ({ thread, botName: bot.name })),
);

/**
 * All threads, in the order the sample data lists them.
 *
 * The list is not a second workspace: every row is a real link into the thread.
 * The rows and their meta use the same primitives as the thread card, so the
 * two screens cannot drift apart.
 */
export default function ThreadsPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <AppBar section="threads" counts={COUNTS} allowance={previewAllowance} />

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
            {ROWS.map(({ thread, botName }) => {
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
