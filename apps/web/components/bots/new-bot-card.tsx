import { Button, Card, PlusIcon } from '../ui';

export interface NewBotCardProps {
  readonly title: string;
  readonly description: string;
  readonly note: string;
  /** Id for the card's heading, so the card can be labelled by it. */
  readonly headingId: string;
  /** Opens the create form. Absent while no API is configured. */
  readonly onCreate?: (() => void) | undefined;
  readonly disabledLabel?: string;
}

/**
 * The dashed "new Bot" card in the gallery.
 *
 * It is a statement plus one action. With an API configured the action opens
 * the create form; in preview the same action is disabled and the note says the
 * preview cannot create a Bot. It never silently becomes clickable.
 */
export function NewBotCard({
  title,
  description,
  note,
  headingId,
  onCreate,
  disabledLabel = 'New bot',
}: Readonly<NewBotCardProps>) {
  return (
    <Card
      variant="dashed"
      radius="xl"
      padding="card"
      elevation="none"
      aria-labelledby={headingId}
      className="flex h-full min-h-34 flex-col items-start justify-center gap-2"
    >
      <span
        aria-hidden="true"
        className="grid size-10 place-items-center rounded-sm border border-line bg-surface text-ink"
      >
        <PlusIcon size={16} />
      </span>
      <h2 id={headingId} className="text-sm font-semibold text-ink">
        {title}
      </h2>
      <p className="text-xs leading-snug text-subtle">{description}</p>
      <p className="text-2xs leading-normal text-subtle">{note}</p>
      <Button
        variant="secondary"
        size="sm"
        disabled={onCreate === undefined}
        onClick={onCreate}
        className="mt-1"
        title={onCreate === undefined ? note : undefined}
      >
        {onCreate === undefined ? disabledLabel : 'Create bot'}
      </Button>
    </Card>
  );
}
