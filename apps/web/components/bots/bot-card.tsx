import Link from 'next/link';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ChevronRightIcon,
  MetaRow,
  type AvatarTone,
  type MetaItem,
} from '../ui';

export interface BotCardProps {
  readonly name: string;
  readonly initials: string;
  readonly tone?: AvatarTone;
  readonly purpose: string;
  readonly href: string;
  /** Memory, thread and other facts shown in the footer. */
  readonly metaItems: readonly MetaItem[];
  readonly liveRunCount?: number;
  readonly openLabel?: string;
  /** Opens the edit card in place; absent when the API is not configured. */
  readonly onEdit?: (() => void) | undefined;
}

/**
 * One Bot in the gallery: identity, one-sentence purpose, facts, and a way in.
 *
 * The main surface is a link, so the name, the purpose and the footer all lead
 * to the same place and the card is one tab stop. The edit control is a
 * separate action with its own focus ring and 44px target; it never nests a
 * button inside the link.
 */
export function BotCard({
  name,
  initials,
  tone = 'neutral',
  purpose,
  href,
  metaItems,
  liveRunCount = 0,
  openLabel = 'Open',
  onEdit,
}: Readonly<BotCardProps>) {
  return (
    <Card
      radius="xl"
      padding="none"
      elevation="card"
      className={
        'group flex h-full flex-col transition-[transform,box-shadow,border-color] ' +
        'duration-[var(--habi-duration-base)] ease-standard hover:border-line-strong hover:shadow-lift ' +
        'motion-safe:hover:-translate-y-0.5'
      }
    >
      <Link
        href={href}
        className="flex flex-1 flex-col gap-3.5 p-card sm:p-5"
      >
        <div className="flex items-start gap-3.5">
          <Avatar name={name} initials={initials} tone={tone} size="md" />
          <div className="min-w-0">
            <h2 className="text-[1.1875rem] leading-tight font-semibold tracking-heading text-ink">
              {name}
            </h2>
            <p className="mt-1.5 text-[0.875rem] leading-normal text-subtle">{purpose}</p>
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-line-soft pt-3.5 text-2xs text-subtle">
          <MetaRow as="span" variant="spaced" items={metaItems} />

          {liveRunCount === 0 ? null : (
            <Badge tone="accent" dot>
              {liveRunCount === 1 ? '1 run live' : `${liveRunCount} runs live`}
            </Badge>
          )}

          <span className="ml-auto inline-flex items-center gap-0.5 text-xs font-semibold text-ink">
            {openLabel}
            <ChevronRightIcon
              size={14}
              className="transition-transform duration-[var(--habi-duration-fast)] ease-standard group-hover:translate-x-0.5"
            />
          </span>
        </div>
      </Link>

      {onEdit === undefined ? null : (
        <div className="border-t border-line-soft px-2 py-1">
          <Button variant="ghost" size="sm" onClick={onEdit} className="min-h-11 px-2">
            Edit bot
          </Button>
        </div>
      )}
    </Card>
  );
}
