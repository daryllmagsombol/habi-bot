import { Card, PlusIcon } from '../ui';

export interface NewBotCardProps {
  readonly title: string;
  readonly description: string;
  readonly note: string;
  /** Id for the card's heading, so the card can be labelled by it. */
  readonly headingId: string;
}

/**
 * The dashed "new Bot" card in the gallery.
 *
 * It is a statement, not a disabled button: creating a Bot needs the Bots API,
 * and the note says so. When the API lands, this card gains an action instead
 * of silently becoming clickable.
 */
export function NewBotCard({ title, description, note, headingId }: Readonly<NewBotCardProps>) {
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
    </Card>
  );
}
