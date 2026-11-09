'use client';

import type { ReactNode } from 'react';
import { Badge, Button } from '../ui';
import type { SkillView } from './types';

export interface SkillsPanelProps {
  readonly skills: readonly SkillView[];
  readonly botId: string;
  readonly state: 'loading' | 'ready' | 'error';
  readonly error?: ReactNode;
  readonly onAttach: (skillId: string) => void;
  readonly onDetach: (skillId: string) => void;
  readonly pendingId?: string | undefined;
}

/**
 * The owner's skills and their attachment to this Bot. Attachment is metadata:
 * it never changes the Bot instructions or grants capability.
 */
export function SkillsPanel({
  skills,
  botId,
  state,
  error,
  onAttach,
  onDetach,
  pendingId,
}: Readonly<SkillsPanelProps>) {
  if (state === 'loading') {
    return <p className="text-xs leading-relaxed text-muted">Loading skills…</p>;
  }

  if (state === 'error') {
    return (
      <p role="alert" className="text-xs leading-relaxed text-danger">
        {error ?? 'The skill list could not be loaded. Nothing was invented.'}
      </p>
    );
  }

  if (skills.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        This account has no skills yet. Creating a skill is not exposed by this interface.
      </p>
    );
  }

  return (
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
          </li>
        );
      })}
    </ul>
  );
}
