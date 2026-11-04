'use client';

import { useState } from 'react';
import { Badge } from '../ui';
import type { MemoryGate, MemoryGateItem } from './types';

interface GateState {
  readonly id: string;
  readonly bot: boolean;
  readonly thread: boolean;
}

export interface MemoryGatesProps {
  readonly memories: readonly MemoryGateItem[];
  /** Called after a switch moves; the parent owns persistence. */
  readonly onToggle?: ((id: string, gate: MemoryGate, next: boolean) => void) | undefined;
  readonly ruleNote?: string | undefined;
  readonly changedNote?: string | undefined;
}

const DEFAULT_RULE =
  'Both approvals are needed. Turning one off holds the memory back without deleting it.';
const DEFAULT_CHANGED = 'This change has not been saved.';

/**
 * The two approvals, as two real checkboxes.
 *
 * "Recalled" requires both; one switch off means the memory is held back, not
 * deleted. The controls work, but the change lives only in this tab — the
 * status line says so the moment a switch moves.
 */
export function MemoryGates({
  memories,
  onToggle,
  ruleNote = DEFAULT_RULE,
  changedNote = DEFAULT_CHANGED,
}: Readonly<MemoryGatesProps>) {
  const [gates, setGates] = useState<readonly GateState[]>(() =>
    memories.map((memory) => ({
      id: memory.id,
      bot: memory.botApproved,
      thread: memory.threadApproved,
    })),
  );
  const [changed, setChanged] = useState(false);

  function toggle(id: string, field: MemoryGate) {
    setGates((previous) =>
      previous.map((gate) => (gate.id === id ? { ...gate, [field]: !gate[field] } : gate)),
    );
    const current = gates.find((gate) => gate.id === id);
    onToggle?.(id, field, !(current?.[field] ?? false));
    setChanged(true);
  }

  if (memories.length === 0) {
    return <p className="text-xs leading-normal text-muted">No memories saved.</p>;
  }

  return (
    <div>
      <ul>
        {memories.map((memory) => {
          const gate = gates.find((candidate) => candidate.id === memory.id);
          const bot = gate?.bot ?? false;
          const thread = gate?.thread ?? false;
          const recalled = bot && thread;

          return (
            <li key={memory.id} className="border-b border-line-soft py-3 first:pt-0 last:border-b-0">
              <div className="flex items-start justify-between gap-3">
                <p className="text-xs leading-normal text-muted">{memory.text}</p>
                <Badge tone={recalled ? 'accent' : 'neutral'} dot={recalled} className="shrink-0">
                  {recalled ? 'Recalled' : 'Held'}
                </Badge>
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-2.5 text-muted transition-colors hover:border-line-strong pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    checked={bot}
                    onChange={() => toggle(memory.id, 'bot')}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-2xs font-medium text-muted">Bot</span>
                  <span className="sr-only"> approval for “{memory.text}”</span>
                </label>

                <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface px-2.5 text-muted transition-colors hover:border-line-strong pointer-coarse:min-h-11">
                  <input
                    type="checkbox"
                    checked={thread}
                    onChange={() => toggle(memory.id, 'thread')}
                    className="size-3.5 accent-[var(--accent)]"
                  />
                  <span className="text-2xs font-medium text-muted">Thread</span>
                  <span className="sr-only"> approval for “{memory.text}”</span>
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      <p role="status" aria-live="polite" className="mt-3 text-xs leading-relaxed text-subtle">
        {changed ? changedNote : ruleNote}
      </p>
    </div>
  );
}
