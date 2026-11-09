'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FormMessage, TextArea, TextField } from '../ui';

export interface BotFormValues {
  readonly name: string;
  readonly purpose: string;
  readonly instructions: string;
}

export interface BotFormProps {
  readonly mode: 'create' | 'edit';
  readonly initial?: Partial<BotFormValues> | undefined;
  readonly onSubmit: (values: BotFormValues) => void;
  readonly onCancel: () => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
}

/**
 * The Bot profile form, reused by the gallery's create card and the Bot page's
 * edit card. It owns only the draft; the caller owns the request and its
 * outcome. Purpose maps to the API's `description`, which is the text the
 * gallery shows under the name.
 */
export function BotForm({
  mode,
  initial,
  onSubmit,
  onCancel,
  pending = false,
  error,
  status,
}: Readonly<BotFormProps>) {
  const baseId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [purpose, setPurpose] = useState(initial?.purpose ?? '');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const canSubmit = name.trim().length > 0 && !pending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    onSubmit({
      name: name.trim(),
      purpose: purpose.trim(),
      instructions: instructions.trim(),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <TextField
        id={`${baseId}-name`}
        label="Name"
        required
        maxLength={120}
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint="The name the gallery and every thread header show."
      />

      <TextField
        id={`${baseId}-purpose`}
        label="Purpose"
        maxLength={280}
        value={purpose}
        onChange={(event) => setPurpose(event.target.value)}
        hint="One sentence shown under the name. Optional; the first instruction line is shown when it is empty."
      />

      <TextArea
        id={`${baseId}-instructions`}
        label="Instructions"
        rows={6}
        maxLength={20_000}
        value={instructions}
        onChange={(event) => setInstructions(event.target.value)}
        hint="Plain text guidance stored with the Bot. It is data, never executable capability."
      />

      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={pending}>
          {mode === 'create' ? 'Create bot' : 'Save changes'}
        </Button>
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
