import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { botTone } from '../../../components/bots';
import type { MemoryGateItem, MemoryItem, PanelRun } from '../../../components/panels';
import type { TranscriptMessage } from '../../../components/threads';
import { BotWorkspace } from './workspace';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';
import { botHref, readPanel, readParam, threadHref } from '../../../lib/links';
import {
  findAttachment,
  findBot,
  findThread,
  previewAllowance,
  previewBots,
  previewOwner,
  shortWhen,
  totalThreadCount,
  type PreviewBot,
  type PreviewMessage,
  type PreviewRun,
  type PreviewThread,
} from '../../../lib/preview-data';

const COUNTS = { bots: previewBots.length, threads: totalThreadCount() };

export interface BotPageProps {
  readonly params: Promise<{ botId: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function toRun(run: PreviewRun): PanelRun {
  return {
    id: run.id,
    state: run.state,
    inTokens: run.inTokens,
    outTokens: run.outTokens,
    durationMs: run.durationMs,
    tools: 0,
    events: run.events,
  };
}

function toTranscript(
  message: PreviewMessage,
  documentHref: string | undefined,
): TranscriptMessage {
  return {
    id: message.id,
    variant: message.role === 'user' ? 'user' : 'bot',
    at: message.at,
    paragraphs: message.paragraphs,
    state: message.streaming === true ? 'streaming' : 'complete',
    citation:
      message.citation === undefined || documentHref === undefined
        ? undefined
        : {
            label: message.citation.label,
            href: `${documentHref}#${message.citation.anchor}`,
          },
    run: message.run === undefined ? undefined : toRun(message.run),
  };
}

function toThread(botId: string, thread: PreviewThread): WorkspaceThread {
  const attachment = findAttachment(thread);
  const documentHref = threadHref(botId, thread.id, 'document');
  const run = thread.messages.findLast((message) => message.run !== undefined)?.run;

  return {
    id: thread.id,
    listItem: {
      id: thread.id,
      title: thread.title,
      time: shortWhen(thread.at),
      href: threadHref(botId, thread.id),
    },
    view: {
      id: thread.id,
      title: thread.title,
      metaItems: [
        { key: 'at', label: thread.at, className: 'u-figures' },
        { key: 'attachment', label: attachment === undefined ? 'No attachment' : '1 attachment' },
      ],
      messages: thread.messages.map((message) =>
        toTranscript(message, attachment === undefined ? undefined : documentHref),
      ),
    },
    document: attachment,
    run: run === undefined ? undefined : toRun(run),
    hrefs: {
      conversation: threadHref(botId, thread.id),
      document: documentHref,
      context: threadHref(botId, thread.id, 'context'),
    },
  };
}

function toMemoryItems(bot: PreviewBot): readonly MemoryItem[] {
  return bot.memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    recalled: memory.botApproved && memory.threadApproved,
  }));
}

function toMemoryGates(bot: PreviewBot): readonly MemoryGateItem[] {
  return bot.memories.map((memory) => ({
    id: memory.id,
    text: memory.text,
    botApproved: memory.botApproved,
    threadApproved: memory.threadApproved,
  }));
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
 * A Bot's workspace. This route owns data selection and provenance: it resolves
 * the Bot and thread, maps the sample records into the display shapes the
 * components take, and hands the result to `<BotWorkspace>` as one object. No
 * card, row, bubble or panel markup is written here.
 *
 * Validation happens on the server: an unknown Bot or thread is a real 404. The
 * workspace itself is a client component so selection can animate in place while
 * the URL keeps up; the first render is still server-rendered from `?thread=`
 * and `?panel=`, so deep links and reloads land on the same view.
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

  const items = toMemoryItems(bot);
  const approved = items.filter((memory) => memory.recalled).length;
  const summary =
    items.length === 0
      ? 'No tools · No memories saved'
      : `No tools · ${approved} of ${items.length} memories selected`;

  const data: WorkspaceData = {
    bot: {
      id: bot.id,
      name: bot.name,
      initials: bot.initials,
      tone: botTone(bot.id),
      summary,
      baseHref: botHref(bot.id),
    },
    threads: bot.threads.map((item) => toThread(bot.id, item)),
    memories: toMemoryGates(bot),
    memoryItems: items,
    approvedMemories: approved,
    counts: COUNTS,
    allowance: previewAllowance,
    owner: previewOwner,
  };

  return (
    <BotWorkspace
      key={`${threadId ?? 'list'}:${readPanel(readParam(query.panel)) ?? 'none'}`}
      data={data}
      initialThreadId={threadId}
      initialPanel={readPanel(readParam(query.panel))}
    />
  );
}
