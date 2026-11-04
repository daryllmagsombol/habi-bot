import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BotWorkspace } from '../../../components/workspace/bot-workspace';
import { findBot, findThread } from '../../../lib/preview-data';
import { readPanel, readParam } from '../../../lib/links';

export interface BotPageProps {
  readonly params: Promise<{ botId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: BotPageProps): Promise<Metadata> {
  const { botId } = await params;
  const bot = findBot(botId);

  if (bot === undefined) {
    return { title: 'Bot not found' };
  }

  return {
    title: `${bot.name} · Threads`,
    description: `${bot.purpose} A thread preview with local sample data.`,
  };
}

/**
 * A Bot's workspace: thread list on the left, conversation in the right pane,
 * and the Document or Context panel docked beside it on a wide screen.
 *
 * Validation happens here, on the server: an unknown Bot or thread is a real
 * 404. The workspace itself is a client component so selection can animate in
 * place while the URL keeps up; the first render is still server-rendered from
 * `?thread=` and `?panel=`, so deep links and reloads land on the same view.
 */
export default async function BotPage({ params, searchParams }: BotPageProps) {
  const { botId } = await params;
  const query = await searchParams;

  const bot = findBot(botId);

  if (bot === undefined) {
    notFound();
  }

  const threadId = readParam(query.thread);
  const thread = findThread(bot, threadId);

  if (thread === undefined) {
    // Every sample Bot has at least one thread. A Bot with none needs its own
    // empty state once the Bots API can return one.
    notFound();
  }

  return (
    <BotWorkspace
      key={`${threadId ?? 'list'}:${readPanel(readParam(query.panel)) ?? 'none'}`}
      bot={bot}
      initialThreadId={threadId}
      initialPanel={readPanel(readParam(query.panel))}
    />
  );
}
