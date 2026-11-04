import type { Metadata } from 'next';
import { AppBar } from '../../components/app-bar';
import { BotGallery, botTone, type BotGalleryItem } from '../../components/bots';
import { DocumentIcon, SkipLink } from '../../components/ui';
import { botHref } from '../../lib/links';
import {
  liveThreadCount,
  previewAllowance,
  previewBots,
  totalThreadCount,
  type PreviewBot,
} from '../../lib/preview-data';

export const metadata: Metadata = {
  title: 'Your bots',
  description:
    'The Bot gallery in the Habi interface preview. Sample Bots, local data, nothing saved.',
};

function memoryLabel(bot: PreviewBot): string {
  const count = bot.memories.length;

  if (count === 0) {
    return 'No memory';
  }

  return count === 1 ? '1 memory' : `${count} memories`;
}

function threadLabel(bot: PreviewBot): string {
  const count = bot.threads.length;
  return count === 1 ? '1 thread' : `${count} threads`;
}

const COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

const CARDS: readonly BotGalleryItem[] = previewBots.map((bot) => ({
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

export default function BotsPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <AppBar section="bots" counts={COUNTS} allowance={previewAllowance} />

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
          bots={CARDS}
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
