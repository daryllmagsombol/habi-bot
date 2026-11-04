'use client';

import { BotIdentity } from '../../../components/bots';
import { Button } from '../../../components/ui';
import type { WorkspaceData } from './workspace-data';

const ACTIONS = [
  { key: 'instructions', label: 'Edit instructions', variant: 'secondary' },
  { key: 'new-thread', label: 'New thread', variant: 'primary' },
] as const;

export interface WorkspaceIdentityProps {
  readonly data: WorkspaceData;
}

/**
 * The Bot heading and its two unavailable actions. Both say why they are
 * disabled: the API exposes neither instructions editing nor thread creation.
 */
export function WorkspaceIdentity({ data }: Readonly<WorkspaceIdentityProps>) {
  const live = data.mode === 'live';
  const unavailable = live ? 'Not exposed by this API yet' : 'Not available in this preview';

  return (
    <BotIdentity
      backHref="/bots"
      name={data.bot.name}
      initials={data.bot.initials}
      tone={data.bot.tone}
      summary={data.bot.summary}
      actions={
        <>
          {ACTIONS.map(({ key, label, variant }) => (
            <Button
              key={key}
              variant={variant}
              size="sm"
              disabled
              title={unavailable}
              className="w-full sm:w-auto"
            >
              {label}
            </Button>
          ))}
        </>
      }
    />
  );
}
