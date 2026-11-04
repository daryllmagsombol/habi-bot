import type { Metadata } from 'next';
import Link from 'next/link';
import { AppBar } from '../../components/app-bar';
import { BotMark } from '../../components/bot-mark';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Container } from '../../components/ui/container';
import { EmptyState } from '../../components/ui/empty-state';
import { ChevronRightIcon, PlusIcon } from '../../components/ui/icons';
import { PageHeader } from '../../components/ui/page-header';
import { SkipLink } from '../../components/ui/skip-link';
import { previewBots, type PreviewBot } from '../../lib/preview-data';
import { botHref } from '../../lib/links';

export const metadata: Metadata = {
  title: 'Bots',
  description:
    'The Bot gallery in the Habi interface preview. Sample Bots, local data, nothing saved.',
};

function lastActivity(bot: PreviewBot): string {
  return bot.threads[0]?.at ?? 'No activity yet';
}

function BotCard({ bot }: Readonly<{ bot: PreviewBot }>) {
  return (
    <article>
      <Link
        href={botHref(bot.id)}
        className="group flex h-full flex-col gap-5 rounded-sm border border-line bg-surface p-5 transition-colors duration-[var(--habi-duration-fast)] ease-standard hover:border-line-strong hover:bg-canvas"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <BotMark bot={bot} />
            <h2 className="min-w-0 text-title tracking-heading text-ink">{bot.name}</h2>
          </div>
          <ChevronRightIcon
            size={16}
            className="mt-1 shrink-0 text-subtle transition-transform duration-[var(--habi-duration-fast)] group-hover:translate-x-0.5 group-hover:text-ink motion-reduce:transition-none"
          />
        </div>

        <p className="-mt-2 text-sm leading-relaxed text-muted">{bot.purpose}</p>

        <dl className="mt-auto grid grid-cols-2 gap-3 border-t border-line pt-3">
          <div>
            <dt className="u-label text-subtle">Conversations</dt>
            <dd className="u-figures mt-1 text-sm text-ink">{bot.threads.length}</dd>
          </div>
          <div>
            <dt className="u-label text-subtle">Last active</dt>
            <dd className="u-figures mt-1 text-xs text-muted">{lastActivity(bot)}</dd>
          </div>
        </dl>
      </Link>
    </article>
  );
}

export default function BotsPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />

      <AppBar section="bots" />

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        <Container size="wide" className="py-10 sm:py-12 lg:py-14">
          <PageHeader
            title="Bots"
            description="Three assistants, each with its own instructions, memory, and conversations. Open one to read its threads and the evidence behind a reply."
          />

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {previewBots.map((bot) => (
              <BotCard key={bot.id} bot={bot} />
            ))}
          </div>

          <EmptyState
            layout="inline"
            headingLevel={2}
            mark={<PlusIcon size={16} />}
            title="New Bot"
            description="Give it instructions, decide what it may remember, and keep tools off. Creating one needs the Bots API, which is not wired in this preview."
            action={<Button variant="secondary" disabled>Create a Bot</Button>}
            className="mt-4"
          />

          <div className="mt-10 flex flex-wrap items-start justify-between gap-4 border-t border-line pt-4">
            <p className="max-w-[62ch] text-xs leading-relaxed text-muted">
              These Bots, their conversations, and every figure in the panels are local sample
              data. Nothing is saved, no model is called, and the Bots API is not connected yet.
            </p>
            <Link
              href="/start"
              className="inline-flex min-h-11 items-center text-xs font-medium text-ink underline underline-offset-4 hover:no-underline"
            >
              See the identity screens
            </Link>
          </div>
        </Container>
      </main>

      <footer className="border-t border-line">
        <Container
          size="wide"
          className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 py-5 text-xs text-muted"
        >
          <span>Habi · Interface preview</span>
          <span className="flex items-center gap-2">
            <Badge tone="outline">Sample data</Badge>
            No requests leave this page.
          </span>
        </Container>
      </footer>
    </div>
  );
}
