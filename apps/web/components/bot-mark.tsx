import type { BotId, PreviewBot } from '../lib/preview-data';

export type BotMarkSize = 'sm' | 'md';

/* One flat tint per Bot. The tint is identity, not state: it never encodes
 * activity, so it cannot contradict the badges. */
const TONE: Record<BotId, string> = {
  'field-notes': 'border-accent-line bg-accent-soft text-accent-ink',
  'draft-partner': 'border-line-strong bg-sunken text-ink',
  'second-reader': 'border-signal-line bg-signal-soft text-signal-ink',
};

const SIZE: Record<BotMarkSize, string> = {
  sm: 'size-10 text-xs',
  md: 'size-14 text-base',
};

export interface BotMarkProps {
  readonly bot: PreviewBot;
  readonly size?: BotMarkSize;
  readonly className?: string;
}

/**
 * A Bot's monogram. Square, ruled, and tinted by identity — the gallery and the
 * thread rail use the same mark at two sizes, so a Bot is recognisable before
 * its name is read.
 */
export function BotMark({ bot, size = 'md', className }: Readonly<BotMarkProps>) {
  return (
    <span
      aria-hidden="true"
      className={[
        'grid shrink-0 place-items-center rounded-xs border font-display font-semibold',
        SIZE[size],
        TONE[bot.id],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {bot.initials}
    </span>
  );
}
