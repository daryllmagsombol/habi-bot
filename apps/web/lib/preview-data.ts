/**
 * Local preview data.
 *
 * These are static strings written for the interface preview. No request is
 * made, nothing is persisted, and no model is called. Every screen that renders
 * this file says so. When the Bots and thread APIs land (see the workspace
 * wiring note in the design-system spec), this module is deleted rather than
 * adapted: it is sample content, not a client.
 */

export type BotId = 'field-notes' | 'draft-partner' | 'second-reader';

export type RunState = 'complete' | 'streaming';

export interface PreviewMemory {
  readonly id: string;
  readonly text: string;
  readonly botApproved: boolean;
  readonly threadApproved: boolean;
}

export interface PreviewRunEvent {
  readonly at: string;
  readonly label: string;
  readonly seq: number;
}

export interface PreviewRun {
  readonly id: string;
  readonly state: RunState;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly durationMs: number;
  readonly events: readonly PreviewRunEvent[];
}

export interface PreviewMessage {
  readonly id: string;
  readonly role: 'user' | 'bot';
  readonly at: string;
  readonly paragraphs: readonly string[];
  /** Shown as an orange cite chip under the paragraph list. */
  readonly citation?: { readonly label: string; readonly anchor: string };
  /** Present on the bot message a run produced. */
  readonly run?: PreviewRun;
  /** Renders the trailing stream caret, for the sample in-flight reply. */
  readonly streaming?: boolean;
}

export interface PreviewThread {
  readonly id: string;
  readonly botId: BotId;
  readonly title: string;
  readonly at: string;
  readonly tokens: number;
  readonly messages: readonly PreviewMessage[];
  readonly attachmentId?: string;
}

export interface PreviewBot {
  readonly id: BotId;
  readonly name: string;
  readonly initials: string;
  readonly purpose: string;
  readonly instruction: string;
  readonly memories: readonly PreviewMemory[];
  readonly threads: readonly PreviewThread[];
}

export type DocBlock =
  | { readonly kind: 'heading'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string; readonly cited?: boolean }
  | { readonly kind: 'list'; readonly items: readonly string[] };

export interface PreviewAttachment {
  readonly id: string;
  readonly name: string;
  readonly bytes: string;
  readonly attachedAt: string;
  readonly blocks: readonly DocBlock[];
  /** Paragraph number in the document, used by the citation note. */
  readonly citedParagraph: number;
}

/** The daily allowance is a product decision, not a number this preview proves. */
export const previewAllowance = {
  used: 12_480,
  limit: 100_000,
  reset: '00:00 Asia/Manila',
} as const;

export const previewAttachments: Readonly<Record<string, PreviewAttachment>> = {
  'stream-notes': {
    id: 'stream-notes',
    name: 'stream-notes.md',
    bytes: '2.1 kB',
    attachedAt: '09:32',
    citedParagraph: 3,
    blocks: [
      { kind: 'heading', text: 'Reconnecting a stream' },
      {
        kind: 'paragraph',
        text: 'The browser keeps one number: the highest sequence it has rendered. Everything else is derived from it.',
      },
      {
        kind: 'paragraph',
        text: 'A reconnect sends that number and asks for what comes after it. The worker replays from the event log, not from memory.',
      },
      {
        kind: 'paragraph',
        cited: true,
        text: 'Ordering by a timestamp lets two events written in the same millisecond swap places, so the cursor has to be the sequence, not the clock.',
      },
      { kind: 'heading', text: 'What to show while paused' },
      {
        kind: 'paragraph',
        text: 'A paused stream keeps the last committed text and says it is paused. It does not clear the bubble just to prove the connection is gone.',
      },
      { kind: 'heading', text: 'Open questions' },
      {
        kind: 'list',
        items: [
          'Does a reconnect replay from the last seq, or from the last message?',
          'What does the reader see when the cursor is older than the retained log?',
        ],
      },
    ],
  },
  'allowance-notes': {
    id: 'allowance-notes',
    name: 'allowance-notes.md',
    bytes: '4.0 kB',
    attachedAt: '09:12',
    citedParagraph: 3,
    blocks: [
      { kind: 'heading', text: 'Daily allowance' },
      {
        kind: 'paragraph',
        text: 'The working number is 100,000 input-plus-output tokens per person per day, against the shared provider key. It resets at 00:00 Asia/Manila.',
      },
      {
        kind: 'paragraph',
        text: 'While only the owner uses the key, no allowance is applied. The figure is a planning decision, not a retroactive limit.',
      },
      { kind: 'heading', text: 'What a cap can promise' },
      {
        kind: 'paragraph',
        cited: true,
        text: 'A cap needs two things before it can be called enforced: a check before dispatch, and a bound on output for a single request. Without both, one long completion can pass 100,000 on its own.',
      },
      {
        kind: 'paragraph',
        text: 'Until then the honest wording is intent, not guarantee: the key is meant to stop at 100,000 tokens a day, and the counter is not allowed to drift upward unseen.',
      },
      { kind: 'heading', text: 'Open questions' },
      {
        kind: 'list',
        items: [
          'Does the output bound live in the provider client or the run worker?',
          'What happens to a run that is mid-flight when the counter crosses the line?',
        ],
      },
    ],
  },
};

const runOrderingRun: PreviewRun = {
  id: '4821',
  state: 'streaming',
  inTokens: 1_284,
  outTokens: 612,
  durationMs: 4_100,
  events: [
    { at: '14:02:11', label: 'run.queued', seq: 1 },
    { at: '14:02:11', label: 'run.started', seq: 2 },
    { at: '14:02:12', label: 'provider.connected · tools 0', seq: 3 },
    { at: '14:02:14', label: 'message.delta · +412 tok', seq: 4 },
  ],
};

const completedRun: PreviewRun = {
  id: '4819',
  state: 'complete',
  inTokens: 1_102,
  outTokens: 486,
  durationMs: 4_600,
  events: [
    { at: '13:58:02', label: 'run.queued', seq: 1 },
    { at: '13:58:02', label: 'run.started', seq: 2 },
    { at: '13:58:03', label: 'provider.connected · tools 0', seq: 3 },
    { at: '13:58:07', label: 'run.completed · 1,588 tok', seq: 4 },
  ],
};

const fieldNotesThreads: readonly PreviewThread[] = [
  {
    id: 'run-ordering',
    botId: 'field-notes',
    title: 'Run event ordering across a reconnect',
    at: 'Today, 14:02',
    tokens: 1_896,
    attachmentId: 'stream-notes',
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '13:58',
        paragraphs: [
          'When the stream drops and I reconnect, do I replay from the last sequence I saw, or from the last complete message?',
        ],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '13:58',
        run: completedRun,
        paragraphs: [
          'From the last sequence you saw. A message is only final once the terminal event commits, and deltas are events, not messages.',
          'Resuming from the last message you kept drops the partial text with no marker that anything is missing. Send the highest sequence you rendered and discard anything at or below it.',
        ],
      },
      {
        id: 'm3',
        role: 'user',
        at: '14:01',
        paragraphs: ['And if I reconnect twice in a row?'],
      },
      {
        id: 'm4',
        role: 'bot',
        at: '14:02',
        streaming: true,
        run: runOrderingRun,
        citation: { label: 'stream-notes.md · ¶ 3', anchor: 'stream-notes-3' },
        paragraphs: [
          'Same rule, and the cursor is cheap to resend, so treat it as idempotent. A second reconnect returns nothing new until the worker writes again — that is the correct answer, not a failure.',
        ],
      },
    ],
  },
  {
    id: 'allowance-copy',
    botId: 'field-notes',
    title: 'Wording for the daily allowance',
    at: 'Today, 09:41',
    tokens: 5_402,
    attachmentId: 'allowance-notes',
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '09:38',
        paragraphs: [
          'How should we describe the daily allowance without promising enforcement we do not have yet?',
        ],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '09:40',
        citation: { label: 'allowance-notes.md · ¶ 3', anchor: 'allowance-notes-3' },
        paragraphs: [
          'State the intent and the gap in the same sentence: the key is meant to stop at 100,000 tokens a day, and the cap is not enforceable by claim alone.',
          'Then name the two things that would make it enforceable — a check before dispatch and an output bound per request — and say plainly that neither is in place.',
        ],
      },
      {
        id: 'm3',
        role: 'user',
        at: '09:41',
        paragraphs: ['That is the version I want in the note. Keep it to two sentences.'],
      },
    ],
  },
  {
    id: 'streaming-reading',
    botId: 'field-notes',
    title: 'What to read on streaming interfaces',
    at: 'Monday, 16:20',
    tokens: 1_102,
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '16:18',
        paragraphs: ['What should I read before changing how the transcript renders a partial answer?'],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '16:20',
        paragraphs: [
          'Start with how screen readers announce a region that changes while it has focus, then read the WAI guidance on live regions. The short version: a streamed answer should stay in one region and finish its sentence, rather than being replaced cell by cell.',
          'After that, look at how other clients mark a stopped stream. A visible paused state is friendlier than a caret that simply disappears.',
        ],
      },
    ],
  },
];

const draftPartnerThreads: readonly PreviewThread[] = [
  {
    id: 'boundary-note',
    botId: 'draft-partner',
    title: 'Draft the POC boundary note',
    at: 'Yesterday, 11:20',
    tokens: 3_140,
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '11:14',
        paragraphs: [
          'Turn these notes into three short sections for the boundary note. Keep the uncertainty where it belongs.',
        ],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '11:16',
        paragraphs: [
          'First pass, three sections: what the proof of concept is, what it deliberately leaves out, and what would have to be true before either statement changes.',
          'I kept one open question at the end of each section. They are the parts that a later reviewer should not have to guess at.',
        ],
      },
      {
        id: 'm3',
        role: 'user',
        at: '11:19',
        paragraphs: ['Section two is doing too much. Split out the part about tools.'],
      },
      {
        id: 'm4',
        role: 'bot',
        at: '11:20',
        paragraphs: [
          'Split. Section two is now only about what the workspace does not do yet; the tool boundary has its own section and names the allow-list as empty.',
        ],
      },
    ],
  },
  {
    id: 'memory-gates-copy',
    botId: 'draft-partner',
    title: 'Memory gates, in plain words',
    at: 'Yesterday, 09:05',
    tokens: 2_080,
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '09:02',
        paragraphs: ['Explain the two memory approvals to someone who has never seen the product.'],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '09:04',
        paragraphs: [
          'A memory only reaches a conversation when both the Bot and the conversation agree to it. Turning one switch off holds it back without deleting it, and the next run simply starts without it.',
          'The reason for two switches: the Bot decides what it is allowed to remember at all, and the conversation decides what is appropriate here.',
        ],
      },
      {
        id: 'm3',
        role: 'user',
        at: '09:05',
        paragraphs: ['Good. Keep "held back" instead of "disabled".'],
      },
    ],
  },
];

const secondReaderThreads: readonly PreviewThread[] = [
  {
    id: 'vague-sentence',
    botId: 'second-reader',
    title: 'Find the vague sentence in the second section',
    at: 'Sunday, 18:42',
    tokens: 1_102,
    messages: [
      {
        id: 'm1',
        role: 'user',
        at: '18:40',
        paragraphs: [
          'Read the second section and point at the sentence that says nothing. One sentence only.',
        ],
      },
      {
        id: 'm2',
        role: 'bot',
        at: '18:42',
        paragraphs: [
          '"The system handles failures gracefully" is the sentence. It names no failure, no observable behaviour, and no recovery. Replace it with the one failure you actually tested and what the reader would see.',
        ],
      },
    ],
  },
];

export const previewBots: readonly PreviewBot[] = [
  {
    id: 'field-notes',
    name: 'Field Notes',
    initials: 'FN',
    purpose: 'Reads what you attach and names the paragraph behind every claim.',
    instruction: 'Cite the attached document by paragraph. Keep uncertainty visible.',
    memories: [
      { id: 'fn-1', text: 'Short sections over bullet dumps.', botApproved: true, threadApproved: true },
      { id: 'fn-2', text: 'Asia/Manila; reviews sit 09:00–11:00.', botApproved: true, threadApproved: true },
      { id: 'fn-3', text: 'Runs this repository on pnpm and Turborepo.', botApproved: true, threadApproved: false },
    ],
    threads: fieldNotesThreads,
  },
  {
    id: 'draft-partner',
    name: 'Draft Partner',
    initials: 'DP',
    purpose: 'Turns a decision you already made into short document sections.',
    instruction: 'Write in the first person, plain verbs, no headings longer than three words.',
    memories: [
      { id: 'dp-1', text: 'Prefers short sections over bullet dumps.', botApproved: true, threadApproved: true },
      { id: 'dp-2', text: 'First person; plain verbs over nominalisations.', botApproved: true, threadApproved: false },
    ],
    threads: draftPartnerThreads,
  },
  {
    id: 'second-reader',
    name: 'Second Reader',
    initials: 'SR',
    purpose: 'Reads a draft and points at the vague sentence, not the whole page.',
    instruction: 'Point at one sentence. Do not rewrite the page unless asked.',
    memories: [
      { id: 'sr-1', text: 'Points at sentences, not sections.', botApproved: true, threadApproved: true },
      { id: 'sr-2', text: 'Asks before suggesting a rewrite.', botApproved: true, threadApproved: true },
    ],
    threads: secondReaderThreads,
  },
];

export function findBot(botId: string): PreviewBot | undefined {
  return previewBots.find((bot) => bot.id === botId);
}

/**
 * Resolves the thread a URL points at. No thread id means "the newest
 * conversation", which is what a desktop reader expects when they open a Bot
 * without picking one.
 */
export function findThread(bot: PreviewBot, threadId: string | undefined): PreviewThread | undefined {
  if (threadId === undefined) {
    return bot.threads[0];
  }

  return bot.threads.find((thread) => thread.id === threadId);
}

export function findAttachment(thread: PreviewThread): PreviewAttachment | undefined {
  if (thread.attachmentId === undefined) {
    return undefined;
  }

  return previewAttachments[thread.attachmentId];
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

export function conversationsLabel(bot: PreviewBot): string {
  const count = bot.threads.length;
  return count === 1 ? '1 conversation' : `${count} conversations`;
}

export function approvedMemoryCount(bot: PreviewBot): number {
  return bot.memories.filter((memory) => memory.botApproved && memory.threadApproved).length;
}
