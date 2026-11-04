/**
 * The one mapping from chat-API DTOs to the workspace's component props.
 *
 * Nothing backend-only (usage internals, dispatch state, ownership columns)
 * reaches a component. Where the API has no answer — memory records, daily
 * usage, attachments, run history for old messages — the mapping leaves the
 * value absent and the screen says so; it never substitutes sample data.
 */
import { botTone } from '../../../components/bots';
import type { PanelRun } from '../../../components/panels';
import type { RunEventView, RunState, RunView, TranscriptMessage } from '../../../components/threads';
import {
  countLabel,
  formatClock,
  formatWhen,
  initialsOf,
  paragraphsOf,
  shortWhen,
} from '../../../lib/api/format';
import type {
  BotDetailDto,
  BotListDto,
  BotThreadPageDto,
  ConversationDto,
  MessageDto,
  MessagePageDto,
  RunDto,
} from '../../../lib/api/types';
import { botHref, threadHref } from '../../../lib/links';
import type { WorkspaceData, WorkspaceThread } from './workspace-data';

/**
 * A generic reader label. The API does not expose an account name, so no name
 * or initial is invented beyond this neutral display.
 */
export const LIVE_OWNER = { name: 'You', initials: 'Y' } as const;

export function messageToTranscript(message: MessageDto): TranscriptMessage {
  return {
    id: message.id,
    variant: message.role === 'assistant' ? 'bot' : 'user',
    at: formatClock(message.createdAt),
    paragraphs: paragraphsOf(message.content),
    state: message.status === 'pending' ? 'streaming' : 'complete',
  };
}

export function runStateOf(run: RunDto): RunState {
  switch (run.status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'streaming';
    case 'completed':
      return 'complete';
    case 'cancelled':
      return 'stopped';
    case 'failed':
    case 'execution_uncertain':
      return 'failed';
  }
}

function durationOf(run: RunDto): number | undefined {
  if (run.startedAt === null || run.finishedAt === null) {
    return undefined;
  }

  const started = new Date(run.startedAt).getTime();
  const finished = new Date(run.finishedAt).getTime();

  if (Number.isNaN(started) || Number.isNaN(finished)) {
    return undefined;
  }

  return Math.max(0, finished - started);
}

/** Maps a Run projection plus whatever events this tab has seen. */
export function runDtoToRunView(
  run: RunDto,
  events: readonly RunEventView[] = [],
): RunView {
  const known = run.usage.status !== 'unknown';
  const duration = durationOf(run);

  return {
    id: run.id,
    state: runStateOf(run),
    inTokens: known ? (run.usage.grossPromptTokens ?? 0) : 0,
    outTokens: known ? (run.usage.grossCompletionTokens ?? 0) : 0,
    tools: 0,
    tokensKnown: known,
    events,
    ...(duration === undefined ? {} : { durationMs: duration }),
  };
}

export function runViewToPanel(run: RunView): PanelRun {
  return {
    id: run.id,
    state: run.state,
    inTokens: run.inTokens,
    outTokens: run.outTokens,
    tools: run.tools,
    tokensKnown: run.tokensKnown ?? true,
    events: run.events,
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
  };
}

function toThread(
  botId: string,
  thread: ConversationDto,
  selectedThreadId: string | undefined,
  messages: MessagePageDto | undefined,
): WorkspaceThread {
  const selected = thread.id === selectedThreadId;
  const turns =
    selected && messages !== undefined ? messages.messages.map(messageToTranscript) : [];

  return {
    id: thread.id,
    listItem: {
      id: thread.id,
      title: thread.title,
      time: shortWhen(thread.updatedAt),
      href: threadHref(botId, thread.id),
    },
    view: {
      id: thread.id,
      title: thread.title,
      metaItems: [
        { key: 'at', label: formatWhen(thread.updatedAt), className: 'u-figures' },
        {
          key: 'messages',
          label: countLabel(thread.lastMessageSeq, 'message', 'messages'),
        },
      ],
      messages: turns,
    },
    document: undefined,
    // The API does not link an existing message to the Run that produced it, so
    // history starts with no run rather than an invented one.
    run: undefined,
    hrefs: {
      conversation: threadHref(botId, thread.id),
      document: threadHref(botId, thread.id, 'document'),
      context: threadHref(botId, thread.id, 'context'),
    },
  };
}

export interface LiveWorkspaceInput {
  readonly detail: BotDetailDto;
  readonly bots: BotListDto;
  readonly threads: BotThreadPageDto;
  readonly selectedThreadId: string | undefined;
  readonly messages: MessagePageDto | undefined;
}

export function buildLiveWorkspace(input: LiveWorkspaceInput): WorkspaceData {
  const { detail, bots, threads, selectedThreadId, messages } = input;
  const botId = detail.bot.id;
  const threadCount = bots.bots.reduce(
    (total, bot) => total + bot.conversationCount,
    0,
  );

  return {
    bot: {
      id: botId,
      name: detail.bot.name,
      initials: initialsOf(detail.bot.name),
      tone: botTone(botId),
      summary: 'No tools · Memory not exposed by this API',
      baseHref: botHref(botId),
    },
    threads: threads.threads.map((thread) =>
      toThread(botId, thread, selectedThreadId, messages),
    ),
    memories: [],
    memoryItems: [],
    approvedMemories: 0,
    counts: { bots: bots.bots.length, threads: threadCount },
    owner: LIVE_OWNER,
    mode: 'live',
  };
}
