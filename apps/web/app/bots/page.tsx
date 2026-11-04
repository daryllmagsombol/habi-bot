import type { Metadata } from 'next';
import { AppBar } from '../../components/app-bar';
import { BotGallery, botTone, type BotGalleryItem } from '../../components/bots';
import { Button, DocumentIcon, EmptyState, SkipLink } from '../../components/ui';
import { botHref } from '../../lib/links';
import { readApiConfig } from '../../lib/api/config';
import { countLabel, initialsOf } from '../../lib/api/format';
import { callerCookieHeader, fetchBots } from '../../lib/api/server';
import type { BotSummaryDto } from '../../lib/api/types';
import { DataStatePage } from '../data-state';
import {
  liveThreadCount,
  previewAllowance,
  previewBots,
  totalThreadCount,
  type PreviewBot,
} from '../../lib/preview-data';

const PREVIEW_COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

/**
 * Configuration and the session cookie are read per request, so the same build
 * can render the preview with no API configured and the live records with one.
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  if (readApiConfig().kind !== 'unset') {
    return {
      title: 'Your bots',
      description: 'Bots from the Habi chat API.',
    };
  }

  return {
    title: 'Your bots',
    description:
      'The Bot gallery in the Habi interface preview. Sample Bots, local data, nothing saved.',
  };
}

function memoryLabel(bot: PreviewBot): string {
  const count = bot.memories.length;

  if (count === 0) {
    return 'No memory';
  }

  return count === 1 ? '1 memory' : `${count} memories`;
}

function threadLabel(bot: PreviewBot | BotSummaryDto): string {
  const count = 'threads' in bot ? bot.threads.length : bot.conversationCount;
  return count === 1 ? '1 thread' : `${count} threads`;
}

const PREVIEW_CARDS: readonly BotGalleryItem[] = previewBots.map((bot) => ({
  id: bot.id,
  name: bot.name,
  initials: bot.initials,
  tone: botTone(bot.id),
  purpose: bot.purpose,
  href: botHref(bot.id),
  metaItems: [
    {
      key: 'memories',
      label: memoryLabel(bot),
      icon: bot.memories.length === 0 ? undefined : <DocumentIcon size={12} />,
    },
    { key: 'threads', label: threadLabel(bot) },
  ],
  liveRunCount: liveThreadCount(bot),
}));

function liveCards(bots: readonly BotSummaryDto[]): readonly BotGalleryItem[] {
  return bots.map((bot) => ({
    id: bot.id,
    name: bot.name,
    initials: initialsOf(bot.name),
    tone: botTone(bot.id),
    purpose: bot.purpose,
    href: botHref(bot.id),
    metaItems: [
      { key: 'memory', label: 'Memory not exposed' },
      { key: 'threads', label: threadLabel(bot) },
    ],
  }));
}

export default async function BotsPage() {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return (
      <div className="flex min-h-svh flex-col">
        <SkipLink />

        <AppBar section="bots" counts={PREVIEW_COUNTS} allowance={previewAllowance} />

        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-wide flex-1 px-4 pb-16 focus:outline-none sm:px-6 lg:pb-20"
        >
          <header className="pt-6 pb-6 sm:pt-9 sm:pb-7">
            <h1 className="text-page tracking-display text-ink">Your bots</h1>
            <p className="mt-2.5 max-w-[46ch] text-sm leading-normal text-subtle sm:text-sm">
              Four working assistants, each with its own instructions, memory, and threads. None of
              them can use tools.
            </p>
          </header>

          <BotGallery
            bots={PREVIEW_CARDS}
            newBot={{
              title: 'New bot',
              description: 'Give it instructions, pick what it may remember, and keep tools off.',
              note: 'Not available in this preview.',
            }}
          />

          <p className="mt-10 max-w-[62ch] text-xs leading-relaxed text-subtle">
            These bots, their threads, and every figure on this page are local sample data. Nothing
            is saved, no model is called, and creating a bot is not wired in this preview.
          </p>
        </main>
      </div>
    );
  }

  if (config.kind === 'invalid') {
    return (
      <DataStatePage
        section="bots"
        failure={{ ok: false, reason: 'invalid_config', status: 0 }}
        retryHref="/bots"
      />
    );
  }

  const cookie = await callerCookieHeader();
  const result = await fetchBots(cookie);

  if (!result.ok) {
    return <DataStatePage section="bots" failure={result} retryHref="/bots" />;
  }

  const bots = result.data.bots;
  const threadCount = bots.reduce((total, bot) => total + bot.conversationCount, 0);

  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <AppBar section="bots" counts={{ bots: bots.length, threads: threadCount }} mode="live" />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-wide flex-1 px-4 pb-16 focus:outline-none sm:px-6 lg:pb-20"
      >
        <header className="pt-6 pb-6 sm:pt-9 sm:pb-7">
          <h1 className="text-page tracking-display text-ink">Your bots</h1>
          <p className="mt-2.5 max-w-[52ch] text-sm leading-normal text-subtle sm:text-sm">
            {bots.length === 0
              ? 'This account has no Bot records yet.'
              : `${countLabel(bots.length, 'Bot', 'Bots')} owned by your account, each with its own instructions.`}{' '}
            Memory records and daily usage are not exposed by this API yet.
          </p>
        </header>

        {bots.length === 0 ? (
          <EmptyState
            headingLevel={2}
            title="No Bots yet"
            description="The API returned an owned Bot list with no records. Creating a Bot is not exposed by this API yet, so this is the whole gallery."
            action={<Button disabled>New bot</Button>}
          />
        ) : (
          <BotGallery
            bots={liveCards(bots)}
            newBot={{
              title: 'New bot',
              description: 'Give it instructions, pick what it may remember, and keep tools off.',
              note: 'Creating a Bot is not exposed by this API yet.',
            }}
          />
        )}

        <p className="mt-10 max-w-[62ch] text-xs leading-relaxed text-subtle">
          These records come from the Habi API and belong to your session. Memory, run history,
          token counts, and the daily allowance are not exposed by it yet, so no figure here is
          invented.
        </p>
      </main>
    </div>
  );
}
