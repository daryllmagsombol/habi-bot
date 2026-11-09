'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FormMessage, TextField } from '../ui';

export interface ThreadFormProps {
  readonly mode: 'create' | 'rename';
  readonly initialTitle?: string | undefined;
  /** `undefined` creates with the server's default title. */
  readonly onSubmit: (title: string | undefined) => void;
  readonly onCancel: () => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
}

/**
 * Create or rename a thread. Rename is a real change only: submitting the
 * unchanged title closes the form without a request, because `PATCH` requires a
 * title and an identical one would only append noise.
 */
export function ThreadForm({
  mode,
  initialTitle,
  onSubmit,
  onCancel,
  pending = false,
  error,
  status,
}: Readonly<ThreadFormProps>) {
  const id = useId();
  const [title, setTitle] = useState(initialTitle ?? '');
  const trimmed = title.trim();
  const unchanged = mode === 'rename' && trimmed === (initialTitle ?? '').trim();
  const canSubmit = !pending && (mode === 'create' || (trimmed.length > 0 && !unchanged));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    if (mode === 'rename' && trimmed === (initialTitle ?? '').trim()) {
      onCancel();
      return;
    }

    onSubmit(mode === 'create' && trimmed.length === 0 ? undefined : trimmed);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <TextField
        id={`${id}-title`}
        label={mode === 'create' ? 'Thread title' : 'Rename thread'}
        value={title}
        maxLength={200}
        autoFocus
        onChange={(event) => setTitle(event.target.value)}
        hint={
          mode === 'create'
            ? 'Optional. The server names it “New conversation” when this is empty.'
            : 'Saving writes the title only when it changed.'
        }
      />

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          size="sm"
          loading={pending}
          disabled={mode === 'rename' && trimmed.length === 0}
        >
          {mode === 'create' ? 'Create thread' : 'Save title'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
