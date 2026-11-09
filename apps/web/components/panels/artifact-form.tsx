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

/** `deleted` is not a writer-selectable status; deletion is its own action. */
export type ArtifactEditableStatus = 'draft' | 'final';

const STATUS_OPTIONS = [
  { value: 'draft', label: 'Draft' },
  { value: 'final', label: 'Final' },
] as const;

const CAP_HINT = `Content is capped at ${COUNT.format(
  ARTIFACT_CONTENT_MAX_BYTES,
)} bytes (100 KB) per HTTP request.`;

export interface ArtifactFormValues {
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly content: string;
  /** Metadata mode only; create mode leaves it absent. */
  readonly status?: ArtifactEditableStatus;
}

export interface ArtifactFormInitialValues {
  readonly title?: string | undefined;
  readonly kind?: ArtifactKind | undefined;
  readonly content?: string | undefined;
  readonly status?: ArtifactEditableStatus | undefined;
}

/** The metadata-only patch body: no content field is ever added. */
export interface ArtifactMetadataFormValues {
  readonly title: string;
  readonly kind: ArtifactKind;
  readonly status: ArtifactEditableStatus;
}

export type ArtifactFormMode = 'create' | 'metadata';

export interface ArtifactFormProps {
  readonly onSubmit: (values: ArtifactFormValues) => void;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  /** False when no conversation is open; the reason is shown as the hint. */
  readonly enabled?: boolean | undefined;
  readonly disabledNote?: string | undefined;
  /**
   * `metadata` edits `{title, kind, status}` only: the stored body is not sent
   * and the API preserves it, appending a version. `create` requires content.
   */
  readonly mode?: ArtifactFormMode | undefined;
  readonly initialValues?: ArtifactFormInitialValues | undefined;
}

/**
 * Create one artifact, or edit the metadata of one that already exists.
 *
 * The 100 KB transport cap is enforced here, before a request is sent: an
 * over-cap draft shows the byte count and refuses to submit rather than letting
 * the API answer with a bare `413`. The body is text; it is never rendered as
 * HTML by this form.
 *
 * The two modes are deliberately separate: metadata editing has no content
 * field, so saving it appends a version and leaves the stored content untouched.
 */
export function ArtifactForm({
  onSubmit,
  pending = false,
  error,
  status,
  enabled = true,
  disabledNote,
  mode = 'create',
  initialValues,
}: Readonly<ArtifactFormProps>) {
  const baseId = useId();
  const [title, setTitle] = useState(initialValues?.title ?? '');
  const [kind, setKind] = useState<ArtifactKind>(initialValues?.kind ?? 'markdown');
  const [content, setContent] = useState(initialValues?.content ?? '');
  const [artifactStatus, setArtifactStatus] = useState<ArtifactEditableStatus>(
    initialValues?.status ?? 'draft',
  );

  const editingMetadata = mode === 'metadata';
  const bytes = utf8Bytes(content);
  const overCap = !editingMetadata && bytes > ARTIFACT_CONTENT_MAX_BYTES;
  const canSubmit =
    enabled &&
    !pending &&
    title.trim().length > 0 &&
    (editingMetadata || (content.length > 0 && !overCap));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) {
      return;
    }

    onSubmit({
      title: title.trim(),
      kind,
      content,
      ...(editingMetadata ? { status: artifactStatus } : {}),
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm font-medium text-ink">
        {editingMetadata ? 'Edit metadata' : 'Create an artifact'}
      </p>

      {editingMetadata ? (
        <p className="text-2xs leading-relaxed text-subtle">
          Saving metadata appends a new version and leaves the stored content untouched. Use the
          content editor to change the body; history is append-only in both paths.
        </p>
      ) : null}

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

      {editingMetadata ? (
        <SelectField
          id={`${baseId}-artifact-status`}
          label="Status"
          options={STATUS_OPTIONS}
          disabled={!enabled || pending}
          value={artifactStatus}
          onChange={(event) => setArtifactStatus(event.target.value as ArtifactEditableStatus)}
          hint="Draft or final. Deleting is a separate action and is not offered here."
        />
      ) : (
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
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" loading={pending} disabled={!canSubmit}>
          {editingMetadata ? 'Save metadata' : 'Create artifact'}
        </Button>
        {editingMetadata ? (
          <span className="text-2xs text-subtle">Content is not touched by this form.</span>
        ) : (
          <span className="u-figures text-2xs text-subtle">
            {COUNT.format(bytes)} / {COUNT.format(ARTIFACT_CONTENT_MAX_BYTES)} bytes
          </span>
        )}
      </div>

      <FormMessage error={error} status={status} />
    </form>
  );
}
