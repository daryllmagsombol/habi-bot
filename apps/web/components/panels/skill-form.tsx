'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FormMessage, TextArea, TextField } from '../ui';
import { utf8Bytes } from '../../lib/api/limits';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from './types';

const COUNT = new Intl.NumberFormat('en-US');

export interface SkillFormValues {
  readonly name: string;
  readonly description: string;
  readonly bodyMarkdown: string;
  /** When true the created skill is attached to the Bot whose panel is open. */
  readonly attachToBot: boolean;
}

export interface SkillFormProps {
  readonly onSubmit: (values: SkillFormValues) => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  /** Present when the panel belongs to a Bot, enabling the attachment choice. */
  readonly botName?: string | undefined;
}

/**
 * Create one owner-scoped skill, optionally attached to the open Bot.
 *
 * Every field bound is the API's, enforced before the request: name 1–80
 * characters, description at most 500, body at most 64 KiB of UTF-8. The body
 * is Markdown guidance stored as data; this form never treats it as HTML and a
 * skill grants no tool.
 */
export function SkillForm({
  onSubmit,
  pending = false,
  error,
  status,
  botName,
}: Readonly<SkillFormProps>) {
  const baseId = useId();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [bodyMarkdown, setBodyMarkdown] = useState('');
  const [attachToBot, setAttachToBot] = useState(botName !== undefined);

  const bodyBytes = utf8Bytes(bodyMarkdown);
  const overCap = bodyBytes > SKILL_BODY_MAX_BYTES;
  const canSubmit = !pending && name.trim().length > 0 && !overCap;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    onSubmit({
      name: name.trim(),
      description: description.trim(),
      bodyMarkdown,
      attachToBot: botName === undefined ? false : attachToBot,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm font-medium text-ink">Create a skill</p>

      <TextField
        id={`${baseId}-skill-name`}
        label="Name"
        required
        maxLength={SKILL_NAME_MAX_LENGTH}
        disabled={pending}
        value={name}
        onChange={(event) => setName(event.target.value)}
        hint={`1–${SKILL_NAME_MAX_LENGTH} characters. Names are unique per owner.`}
      />

      <TextField
        id={`${baseId}-skill-description`}
        label="Description"
        maxLength={SKILL_DESCRIPTION_MAX_LENGTH}
        disabled={pending}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        hint={`Optional, up to ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`}
      />

      <TextArea
        id={`${baseId}-skill-body`}
        label="Body Markdown"
        rows={8}
        disabled={pending}
        value={bodyMarkdown}
        onChange={(event) => setBodyMarkdown(event.target.value)}
        error={
          overCap
            ? `This body is ${COUNT.format(bodyBytes)} bytes. The API accepts at most ${COUNT.format(
                SKILL_BODY_MAX_BYTES,
              )} bytes.`
            : undefined
        }
        hint="Stored as untrusted Markdown data. It grants no tools; the tool allow-list stays empty."
      />

      <div className="flex flex-wrap items-center gap-3">
        <span className="u-figures text-2xs text-subtle">
          {COUNT.format(bodyBytes)} / {COUNT.format(SKILL_BODY_MAX_BYTES)} bytes
        </span>

        {botName === undefined ? null : (
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs text-muted">
            <input
              type="checkbox"
              checked={attachToBot}
              disabled={pending}
              onChange={(event) => setAttachToBot(event.target.checked)}
              className="size-3.5 accent-[var(--accent)]"
            />
            Attach to {botName}
          </label>
        )}
      </div>

      <div>
        <Button type="submit" size="sm" loading={pending} disabled={!canSubmit}>
          Create skill
        </Button>
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
