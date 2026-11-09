'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Badge, Button } from '../ui';
import { PaginationFooter } from './pagination-footer';
import { SkillForm } from './skill-form';
import type { SkillFormValues } from './skill-form';
import type { SkillView } from './types';

export interface SkillsPanelProps {
  readonly skills: readonly SkillView[];
  readonly botId: string;
  readonly state: 'loading' | 'ready' | 'error';
  readonly error?: ReactNode;
  readonly onAttach: (skillId: string) => void;
  readonly onDetach: (skillId: string) => void;
  readonly pendingId?: string | undefined;
  /** Present when this account may create a skill from the panel. */
  readonly onCreate?: ((values: SkillFormValues) => void) | undefined;
  readonly createPending?: boolean | undefined;
  readonly createError?: string | undefined;
  readonly createStatus?: string | undefined;
  /** Passed to the create form as the attachment choice's label. */
  readonly botName?: string | undefined;
  /** Cursor paging for the owner-scoped skill list. */
  readonly hasMore?: boolean | undefined;
  readonly loadingMore?: boolean | undefined;
  readonly pagingError?: string | undefined;
  readonly onLoadMore?: (() => void) | undefined;
}

/**
 * The owner's skills and their attachment to this Bot.
 *
 * A skill is untrusted Markdown guidance stored as data. Attachment is
 * metadata: it never changes the Bot instructions, grants no tool, and the
 * tool allow-list stays empty. Bodies are shown as plain text inside a
 * disclosure, never parsed as HTML.
 */
export function SkillsPanel({
  skills,
  botId,
  state,
  error,
  onAttach,
  onDetach,
  pendingId,
  onCreate,
  createPending = false,
  createError,
  createStatus,
  botName,
  hasMore = false,
  loadingMore = false,
  pagingError,
  onLoadMore,
}: Readonly<SkillsPanelProps>) {
  const [creating, setCreating] = useState(false);

  const capabilityNote = (
    <div className="mb-3 space-y-1.5">
      <p className="text-xs leading-relaxed text-subtle">
        Skills are Markdown guidance stored as untrusted data. Creating or attaching a skill grants
        no tools; the tool allow-list is empty.
      </p>
      <p className="text-2xs leading-relaxed text-muted">
        Editing an existing skill is not exposed by this API. Attach or detach is metadata only.
      </p>
    </div>
  );

  const createSection =
    onCreate === undefined ? null : (
      <div className="mb-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Close new-skill form' : 'New skill'}
        </Button>

        {creating ? (
          <div className="mt-3 rounded-sm border border-line-soft p-3">
            <SkillForm
              onSubmit={onCreate}
              pending={createPending}
              error={createError}
              status={createStatus}
              botName={botName}
            />
          </div>
        ) : null}
      </div>
    );

  if (state === 'loading') {
    return (
      <div>
        {capabilityNote}
        {createSection}
        <p role="status" className="text-xs leading-relaxed text-muted">
          Loading skills…
        </p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div>
        {capabilityNote}
        {createSection}
        <p role="alert" className="text-xs leading-relaxed text-danger">
          {error ?? 'The skill list could not be loaded. Nothing was invented.'}
        </p>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div>
        {capabilityNote}
        {createSection}
        <p className="text-xs leading-relaxed text-muted">
          {onCreate === undefined
            ? 'This account has no skills yet. Creating a skill is not exposed by this interface.'
            : 'This account has no skills yet. Use “New skill” to create one.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      {capabilityNote}
      {createSection}

      <ul>
        {skills.map((skill) => {
          const attached = skill.botId === botId;
          const pending = pendingId === skill.id;

          return (
            <li key={skill.id} className="border-b border-line-soft py-2.5 first:pt-0 last:border-b-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-ink">{skill.name}</p>
                  {skill.description.length === 0 ? null : (
                    <p className="mt-0.5 text-2xs leading-snug text-muted">{skill.description}</p>
                  )}
                </div>
                <Badge tone={attached ? 'accent' : 'neutral'} dot={attached}>
                  {attached ? 'Attached' : skill.botId === null ? 'Library' : 'Other bot'}
                </Badge>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <span className="u-figures text-2xs text-subtle">
                  {skill.status} · v{skill.version}
                </span>
                {attached ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={pending}
                    onClick={() => onDetach(skill.id)}
                  >
                    Detach
                  </Button>
                ) : skill.botId === null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={pending}
                    onClick={() => onAttach(skill.id)}
                  >
                    Attach to this bot
                  </Button>
                ) : (
                  <span className="text-2xs text-subtle">Attached to another Bot.</span>
                )}
              </div>

              <details className="mt-1">
                <summary className="inline-flex min-h-11 cursor-pointer items-center text-2xs text-subtle">
                  View guidance (plain text)
                </summary>
                <p className="mt-1 whitespace-pre-wrap rounded-sm bg-sunken px-3 py-2 text-2xs leading-relaxed text-muted">
                  {skill.bodyMarkdown.length === 0
                    ? 'This skill has no body text.'
                    : skill.bodyMarkdown}
                </p>
              </details>
            </li>
          );
        })}
      </ul>

      {onLoadMore === undefined ? null : (
        <PaginationFooter
          hasMore={hasMore}
          loading={loadingMore}
          error={pagingError}
          label="Load more skills"
          loadingLabel="Loading more skills…"
          onLoadMore={onLoadMore}
        />
      )}
    </div>
  );
}
