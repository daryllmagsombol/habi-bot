'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BotForm,
  BotFormCard,
  BotGallery,
  type BotFormValues,
  type BotGalleryItem,
  type NewBotCardProps,
} from '../../components/bots';
import {
  chatErrorMessage,
  createBot,
  readBot,
  readCsrfToken,
  updateBot,
} from '../../lib/api/browser';

type Editor =
  | { readonly mode: 'create' }
  | { readonly mode: 'edit'; readonly botId: string };

export interface BotsGalleryLiveProps {
  readonly cards: readonly BotGalleryItem[];
  readonly newBot: Omit<NewBotCardProps, 'headingId' | 'onCreate'>;
}

/**
 * The live gallery coordinator. It owns the create/edit card, the BFF call and
 * the refresh; `BotGallery`, `BotForm` and `BotFormCard` only render props and
 * report intent. A Bot profile is read when the edit card opens, so the form is
 * never populated from list text that omits instructions.
 */
export function BotsGalleryLive({ cards, newBot }: Readonly<BotsGalleryLiveProps>) {
  const router = useRouter();
  const [editor, setEditor] = useState<Editor | undefined>(undefined);
  const [initial, setInitial] = useState<Partial<BotFormValues> | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);

  function openCreate() {
    setEditor({ mode: 'create' });
    setInitial(undefined);
    setError(undefined);
    setStatus(undefined);
  }

  function openEdit(botId: string) {
    setEditor({ mode: 'edit', botId });
    setInitial(undefined);
    setLoading(true);
    setError(undefined);
    setStatus(undefined);

    void readBot(botId)
      .then((detail) => {
        setInitial({
          name: detail.bot.name,
          purpose: detail.bot.description,
          instructions: detail.bot.instructionsMarkdown,
        });
      })
      .catch((error_: unknown) => setError(chatErrorMessage(error_)))
      .finally(() => setLoading(false));
  }

  function close() {
    setEditor(undefined);
    setInitial(undefined);
    setError(undefined);
    setStatus(undefined);
  }

  function save(values: BotFormValues) {
    const token = readCsrfToken();

    if (token === undefined) {
      setError('This session did not publish a CSRF token, so nothing was saved.');
      return;
    }

    setPending(true);
    setError(undefined);
    setStatus(undefined);

    const request =
      editor?.mode === 'edit'
        ? updateBot(
            editor.botId,
            {
              name: values.name,
              description: values.purpose,
              instructionsMarkdown: values.instructions,
            },
            token,
          )
        : createBot(
            {
              name: values.name,
              description: values.purpose,
              instructionsMarkdown: values.instructions,
            },
            token,
          );

    void request
      .then(() => {
        setStatus(editor?.mode === 'edit' ? 'Bot updated.' : 'Bot created.');
        close();
        router.refresh();
      })
      .catch((error_: unknown) => setError(chatErrorMessage(error_)))
      .finally(() => setPending(false));
  }

  return (
    <div className="flex flex-col gap-4">
      {editor === undefined ? null : (
        <BotFormCard
          title={editor.mode === 'create' ? 'New bot' : 'Edit bot'}
          headingId="bot-form-title"
          description={
            editor.mode === 'create'
              ? 'Name it, give it one purpose, and write its instructions. Tools stay off.'
              : 'Name, purpose and instructions. Instructions are data, not capability.'
          }
        >
          {loading ? (
            <p className="text-xs leading-relaxed text-muted">Loading the Bot profile…</p>
          ) : (
            <BotForm
              key={editor.mode === 'edit' ? editor.botId : 'create'}
              mode={editor.mode}
              initial={initial}
              onSubmit={save}
              onCancel={close}
              pending={pending}
              error={error}
              status={status}
            />
          )}
        </BotFormCard>
      )}

      <BotGallery
        bots={cards}
        newBot={newBot}
        onCreate={openCreate}
        onEdit={openEdit}
      />
    </div>
  );
}
