import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { botTone } from '../../../components/bots';
import type { MemoryGateItem, MemoryItem, PanelRun } from '../../../components/panels';
import type { TranscriptMessage } from '../../../components/threads';
import { BotWorkspace } from './workspace';
import { buildLiveWorkspace } from './api-data';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';
import { botHref, readPanel, readParam, threadHref } from '../../../lib/links';
import { readApiConfig } from '../../../lib/api/config';
import { callerCookieHeader, fetchBot, fetchBots, fetchMessages, fetchThreads } from '../../../lib/api/server';
import { DataStatePage } from '../../data-state';
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

/** The API configuration and cookie are request-scoped, not build-scoped. */
export const dynamic = 'force-dynamic';

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

function previewData(bot: PreviewBot): WorkspaceData {
  const items = toMemoryItems(bot);
  const approved = items.filter((memory) => memory.recalled).length;
  const summary =
    items.length === 0
      ? 'No tools · No memories saved'
      : `No tools · ${approved} of ${items.length} memories selected`;

  return {
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
    mode: 'preview',
  };
}

export async function generateMetadata({ params }: BotPageProps): Promise<Metadata> {
  const { botId } = await params;

  if (readApiConfig().kind !== 'unset') {
    const cookie = await callerCookieHeader();
    const result = await fetchBot(botId, cookie);

    if (!result.ok) {
      return { title: 'Bot' };
    }

    return {
      title: `${result.data.bot.name} · Threads`,
      description: result.data.purpose,
    };
  }

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
 * A Bot's workspace. This route owns data selection and provenance.
 *
 * With `HABI_API_URL` unset it renders the unchanged sample-data preview. With
 * it set it reads the owner-scoped API, maps the records in `api-data.ts`, and
 * renders an explicit sign-in or error state for 401/5xx/transport failures.
 * There is no path from a failed request back to the preview.
 *
 * Validation happens on the server: an unknown Bot or thread is a real 404. The
 * workspace itself is a client component so selection and sending can happen in
 * place while the URL keeps up.
 */
export default async function BotPage({ params, searchParams }: BotPageProps) {
  const { botId } = await params;
  const query = await searchParams;
  const requestedThreadId = readParam(query.thread);
  const panel = readPanel(readParam(query.panel));
  const config = readApiConfig();

  if (config.kind === 'unset') {
    const bot = findBot(botId);

    if (bot === undefined) {
      notFound();
    }

    const thread = findThread(bot, requestedThreadId);

    if (thread === undefined) {
      // Every sample Bot has at least one thread. A Bot with none needs its own
      // empty state once the Bots API can return one.
      notFound();
    }

    return (
      <BotWorkspace
        key={`${requestedThreadId ?? 'list'}:${panel ?? 'none'}`}
        data={previewData(bot)}
        initialThreadId={requestedThreadId}
        initialPanel={panel}
      />
    );
  }

  if (config.kind === 'invalid') {
    return (
      <DataStatePage
        section="bots"
        failure={{ ok: false, reason: 'invalid_config', status: 0 }}
        retryHref={botHref(botId)}
      />
    );
  }

  const cookie = await callerCookieHeader();
  const [detailResult, botsResult, threadsResult] = await Promise.all([
    fetchBot(botId, cookie),
    fetchBots(cookie),
    fetchThreads(botId, cookie),
  ]);

  if (!detailResult.ok) {
    if (detailResult.reason === 'not_found') {
      notFound();
    }

    return (
      <DataStatePage
        section="bots"
        failure={detailResult}
        retryHref={botHref(botId)}
      />
    );
  }

  if (!botsResult.ok) {
    return (
      <DataStatePage
        section="bots"
        failure={botsResult}
        retryHref={botHref(botId)}
      />
    );
  }

  if (!threadsResult.ok) {
    return (
      <DataStatePage
        section="bots"
        failure={threadsResult}
        retryHref={botHref(botId)}
      />
    );
  }

  const threads = threadsResult.data.threads;
  const threadId = requestedThreadId ?? threads[0]?.id;

  if (threadId !== undefined && !threads.some((thread) => thread.id === threadId)) {
    notFound();
  }

  let messages;

  if (threadId !== undefined) {
    const messageResult = await fetchMessages(threadId, cookie);

    if (!messageResult.ok) {
      if (messageResult.reason === 'not_found') {
        notFound();
      }

      return (
        <DataStatePage
          section="bots"
          failure={messageResult}
          retryHref={threadHref(botId, threadId)}
        />
      );
    }

    messages = messageResult.data;
  }

  const data = buildLiveWorkspace({
    detail: detailResult.data,
    bots: botsResult.data,
    threads: threadsResult.data,
    selectedThreadId: threadId,
    messages,
  });

  return (
    <BotWorkspace
      key={`${threadId ?? 'empty'}:${panel ?? 'none'}`}
      data={data}
      initialThreadId={threadId}
      initialPanel={panel}
    />
  );
}
