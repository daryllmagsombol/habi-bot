/**
 * The one mapping from chat-API DTOs to the workspace's component props.
 *
 * Nothing backend-only (usage internals, dispatch state, ownership columns)
 * reaches a component. Where the API has no answer — memory records, daily
 * usage, attachments, run history for old messages — the mapping leaves the
 * value absent and the screen says so; it never substitutes sample data.
 */
import { botTone } from '../../../components/bots';
import type {
  DocumentBlock,
  DocumentView,
  MemoryGateItem,
  MemoryItem,
  PanelRun,
} from '../../../components/panels';
import type { RunEventView, RunState, RunView, TranscriptMessage } from '../../../components/threads';
import {
  countLabel,
  formatBytes,
  formatClock,
  formatWhen,
  initialsOf,
  paragraphsOf,
  shortWhen,
} from '../../../lib/api/format';
import type {
  AttachmentMetadataDto,
  BotDetailDto,
  BotListDto,
  BotThreadPageDto,
  ConversationDto,
  MemoryDto,
  MemoryListDto,
  MessageDto,
  MessagePageDto,
  RunDto,
} from '../../../lib/api/types';
import type { ApiResult, AttachmentContentResult } from '../../../lib/api/server';
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

function blocksFromText(text: string): readonly DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }

    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  }

  function flushList() {
    if (list.length === 0) {
      return;
    }

    blocks.push({ kind: 'list', items: list });
    list = [];
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line.length === 0) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^#{1,6}\s+(.*)$/.exec(line);

    if (heading !== null) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', text: heading[1] ?? '' });
      continue;
    }

    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);

    if (bullet !== null) {
      flushParagraph();
      list.push(bullet[1] ?? '');
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return blocks;
}

/**
 * Attachment metadata and, when the content route succeeds, its text. The text
 * is parsed into plain blocks; it is never interpreted as HTML.
 */
export function attachmentToDocument(
  attachment: AttachmentMetadataDto,
  content: ApiResult<AttachmentContentResult>,
): DocumentView {
  const base = {
    id: attachment.id,
    name: attachment.originalFilename,
    bytes: formatBytes(attachment.byteSize),
    attachedAt: formatWhen(attachment.storedAt ?? attachment.createdAt),
    contentType: attachment.contentType,
    citedParagraph: 0,
  } as const;

  if (content.ok) {
    return {
      ...base,
      contentState: 'ready',
      blocks: blocksFromText(content.data.text),
    };
  }

  if (content.reason === 'unsupported' || content.code === 'unsupported_media_type') {
    return {
      ...base,
      contentState: 'unsupported',
      contentMessage:
        'Only text/plain and text/markdown attachments can be read here. The stored bytes were not replaced with sample text.',
      blocks: [],
    };
  }

  if (content.reason === 'unavailable') {
    return {
      ...base,
      contentState: 'unavailable',
      contentMessage:
        'The attachment metadata is available, but this server has no attachment storage root configured, so the text cannot be read.',
      blocks: [],
    };
  }

  return {
    ...base,
    contentState: 'error',
    contentMessage: 'The content request failed. Nothing was invented in its place.',
    blocks: [],
  };
}

export interface MemoryMapping {
  readonly gates: readonly MemoryGateItem[];
  readonly items: readonly MemoryItem[];
  readonly approved: number;
}

export function memoriesToViews(memories: readonly MemoryDto[]): MemoryMapping {
  const gates = memories.map((memory) => ({
    id: memory.id,
    text: memory.content,
    botApproved: memory.botApproved,
    threadApproved: memory.conversationApproved,
  }));

  const items = gates.map((memory) => ({
    id: memory.id,
    text: memory.text,
    recalled: memory.botApproved && memory.threadApproved,
  }));

  return {
    gates,
    items,
    approved: items.filter((memory) => memory.recalled).length,
  };
}

function toThread(
  botId: string,
  thread: ConversationDto,
  selectedThreadId: string | undefined,
  messages: MessagePageDto | undefined,
  documents: readonly DocumentView[],
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
    documents: selected ? documents : [],
    ...(selected && messages !== undefined
      ? {
          beforeCursor: messages.beforeCursor,
          hasMoreBefore: messages.hasMoreBefore,
        }
      : {}),
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
  /** Absent when the memory page could not be read. */
  readonly memories: MemoryListDto | undefined;
  /** Documents for the selected thread; empty when it has none. */
  readonly documents?: readonly DocumentView[];
}

/**
 * The identity card's one-line summary. An unread page says so rather than
 * reporting zero memories.
 */
function memorySummaryOf(
  memories: MemoryListDto | undefined,
  mapping: MemoryMapping,
): string {
  if (memories === undefined) {
    return 'No tools · Memory unavailable';
  }

  if (mapping.items.length === 0) {
    return 'No tools · No memories saved';
  }

  return `No tools · ${mapping.approved} of ${mapping.items.length} memories selected`;
}

export function buildLiveWorkspace(input: LiveWorkspaceInput): WorkspaceData {
  const {
    detail,
    bots,
    threads,
    selectedThreadId,
    messages,
    memories,
    documents = [],
  } = input;
  const botId = detail.bot.id;
  const threadCount = bots.bots.reduce(
    (total, bot) => total + bot.conversationCount,
    0,
  );
  const memoryMapping = memoriesToViews(memories?.memories ?? []);
  const memorySummary = memorySummaryOf(memories, memoryMapping);

  return {
    bot: {
      id: botId,
      name: detail.bot.name,
      initials: initialsOf(detail.bot.name),
      tone: botTone(botId),
      summary: memorySummary,
      description: detail.bot.description,
      instructionsMarkdown: detail.bot.instructionsMarkdown,
      baseHref: botHref(botId),
    },
    threads: threads.threads.map((thread) =>
      toThread(botId, thread, selectedThreadId, messages, documents),
    ),
    memories: memoryMapping.gates,
    memoryItems: memoryMapping.items,
    memoryNextCursor: memories?.nextCursor ?? null,
    memoryState: memories === undefined ? 'unavailable' : 'ready',
    approvedMemories: memoryMapping.approved,
    counts: { bots: bots.bots.length, threads: threadCount },
    owner: LIVE_OWNER,
    mode: 'live',
  };
}
