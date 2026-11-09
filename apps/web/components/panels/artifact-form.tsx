'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, FormMessage, SelectField, TextArea, TextField } from '../ui';
import { ARTIFACT_CONTENT_MAX_BYTES, utf8Bytes } from '../../lib/api/limits';
import type { ArtifactKind } from './types';

const COUNT = new Intl.NumberFormat('en-US');

const KIND_OPTIONS = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'text', label: 'Plain text' },
  { value: 'json', label: 'JSON' },
] as const;

const CAP_HINT = `Content is capped at ${COUNT.format(
  ARTIFACT_CONTENT_MAX_BYTES,
)} bytes (100 KB) per HTTP request.`;

export interface ArtifactFormValues {
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly content: string;
}

export interface ArtifactFormProps {
  readonly onSubmit: (values: ArtifactFormValues) => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  /** False when no conversation is open; the reason is shown as the hint. */
  readonly enabled?: boolean | undefined;
  readonly disabledNote?: string | undefined;
}

/**
 * Create one artifact bound to the conversation that is open.
 *
 * The 100 KB transport cap is enforced here, before a request is sent: an
 * over-cap draft shows the byte count and refuses to submit rather than letting
 * the API answer with a bare `413`. The body is text; it is never rendered as
 * HTML by this form.
 */
export function ArtifactForm({
  onSubmit,
  pending = false,
  error,
  status,
  enabled = true,
  disabledNote,
}: Readonly<ArtifactFormProps>) {
  const baseId = useId();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<ArtifactKind>('markdown');
  const [content, setContent] = useState('');

  const bytes = utf8Bytes(content);
  const overCap = bytes > ARTIFACT_CONTENT_MAX_BYTES;
  const canSubmit =
    enabled && !pending && title.trim().length > 0 && content.length > 0 && !overCap;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    onSubmit({ title: title.trim(), kind, content });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <TextField
        id={`${baseId}-artifact-title`}
        label="Title"
        required
        maxLength={200}
        disabled={!enabled || pending}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        hint="Shown in the artifact list. 1–200 characters."
      />

      <SelectField
        id={`${baseId}-artifact-kind`}
        label="Kind"
        options={KIND_OPTIONS}
        disabled={!enabled || pending}
        value={kind}
        onChange={(event) => setKind(event.target.value as ArtifactKind)}
        hint="The stored text type. It does not change how the body is read here."
      />

      <TextArea
        id={`${baseId}-artifact-content`}
        label="Content"
        rows={8}
        disabled={!enabled || pending}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        error={
          overCap
            ? `This body is ${COUNT.format(bytes)} bytes. Reduce it below the 100 KB transport cap.`
            : undefined
        }
        hint={
          enabled
            ? CAP_HINT
            : (disabledNote ?? 'Open a thread first: an artifact is bound to its conversation.')
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending} disabled={!canSubmit}>
          Create artifact
        </Button>
        <span className="u-figures text-2xs text-subtle">
          {COUNT.format(bytes)} / {COUNT.format(ARTIFACT_CONTENT_MAX_BYTES)} bytes
        </span>
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
