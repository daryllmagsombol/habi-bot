import type { AvatarTone } from '../../../components/ui';
import type { DocumentView, MemoryGateItem, MemoryItem, PanelRun } from '../../../components/panels';
import type { ThreadListItem, ThreadView } from '../../../components/threads';

export interface WorkspaceThread {
  readonly id: string;
  /** The row in the thread card. */
  readonly listItem: ThreadListItem;
  /** The conversation card's title, meta and turns, already display-shaped. */
  readonly view: ThreadView;
  readonly document: DocumentView | undefined;
  readonly run: PanelRun | undefined;
  readonly hrefs: {
    readonly conversation: string;
    readonly document: string;
    readonly context: string;
  };
}

export interface WorkspaceBot {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly tone: AvatarTone;
  /** e.g. "No tools · 2 of 3 memories selected". */
  readonly summary: string;
  /** The Bot page without a thread parameter. */
  readonly baseHref: string;
}

export interface WorkspaceData {
  readonly bot: WorkspaceBot;
  readonly threads: readonly WorkspaceThread[];
  readonly memories: readonly MemoryGateItem[];
  readonly memoryItems: readonly MemoryItem[];
  readonly approvedMemories: number;
  readonly counts: { readonly bots: number; readonly threads: number };
  readonly allowance: { readonly used: number; readonly limit: number; readonly reset: string };
  readonly owner: { readonly name: string; readonly initials: string };
}
