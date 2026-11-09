'use client';

import { useState } from 'react';
import { BotForm, BotFormCard, BotIdentity } from '../../../components/bots';
import { Button } from '../../../components/ui';
import type { WorkspaceActions } from './use-workspace-actions';
import type { WorkspaceData } from './workspace-data';

export interface WorkspaceIdentityProps {
  readonly data: WorkspaceData;
  readonly actions: WorkspaceActions;
}

/**
 * The Bot heading and its two live actions. In preview both are disabled and say
 * why. In live mode the edit card is the same `BotForm` the gallery uses, so the
 * two create/edit surfaces cannot drift apart.
 */
export function WorkspaceIdentity({ data, actions }: Readonly<WorkspaceIdentityProps>) {
  const [editing, setEditing] = useState(false);
  const live = data.mode === 'live';
  const unavailable = 'Not available in this preview';

  return (
    <>
      <BotIdentity
        backHref="/bots"
        name={data.bot.name}
        initials={data.bot.initials}
        tone={data.bot.tone}
        summary={data.bot.summary}
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={!live}
              title={live ? undefined : unavailable}
              className="w-full sm:w-auto"
              onClick={() => setEditing((open) => !open)}
            >
              Edit bot
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!live}
              title={live ? undefined : unavailable}
              className="w-full sm:w-auto"
              onClick={() => actions.createThreadForBot(undefined)}
            >
              New thread
            </Button>
          </>
        }
      />

      {live && editing ? (
        <BotFormCard
          title="Edit bot"
          headingId="bot-edit-title"
          description="Name, purpose and instructions. Instructions are stored as data and never grant a tool."
          className="mb-3"
        >
          <BotForm
            key={`${data.bot.name}:${data.bot.instructionsMarkdown ?? ''}`}
            mode="edit"
            initial={{
              name: data.bot.name,
              purpose: data.bot.description ?? '',
              instructions: data.bot.instructionsMarkdown ?? '',
            }}
            onSubmit={actions.saveBot}
            onCancel={() => setEditing(false)}
            pending={actions.botPending}
            error={actions.botError}
            status={actions.botStatus}
          />
        </BotFormCard>
      ) : null}
    </>
  );
}
