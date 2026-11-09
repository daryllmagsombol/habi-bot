'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FormMessage, TextArea } from '../ui';

export interface MemoryComposerProps {
  /** The open thread; a memory cannot be proposed without one. */
  readonly threadId?: string | undefined;
  readonly onSubmit: (text: string, threadId: string) => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  readonly disabledNote?: string | undefined;
  readonly maxLength?: number;
}

/**
 * Propose a memory from the open conversation. The source thread is part of the
 * request, not a free choice: `threadId` is required by the API and the composer
 * passes the thread that is actually open.
 */
export function MemoryComposer({
  threadId,
  onSubmit,
  pending = false,
  error,
  status,
  disabledNote,
  maxLength = 4_000,
}: Readonly<MemoryComposerProps>) {
  const id = useId();
  const [text, setText] = useState('');
  const enabled = threadId !== undefined && !pending;
  const canSubmit = enabled && text.trim().length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit || threadId === undefined) {
      return;
    }

    onSubmit(text.trim(), threadId);
    setText('');
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <TextArea
        id={`${id}-memory`}
        label="Propose a memory"
        rows={3}
        maxLength={maxLength}
        disabled={!enabled}
        value={text}
        onChange={(event) => setText(event.target.value)}
        hint={
          threadId === undefined
            ? (disabledNote ?? 'Open a thread first: a memory binds to its source conversation.')
            : 'Both the Bot and this thread must approve it before a run can recall it.'
        }
      />

      <div>
        <Button type="submit" variant="secondary" size="sm" loading={pending} disabled={!canSubmit}>
          Propose memory
        </Button>
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
