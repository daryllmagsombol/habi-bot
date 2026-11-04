import Image from 'next/image';

export type AvatarTone = 'iris' | 'sage' | 'apricot' | 'plum' | 'neutral' | 'user';
export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE: Record<AvatarSize, string> = {
  xs: 'size-7 text-[0.6875rem]',
  sm: 'size-11 text-base',
  md: 'size-14 text-xl',
  lg: 'size-[4.5rem] text-2xl',
};

const PIXELS: Record<AvatarSize, number> = {
  xs: 28,
  sm: 44,
  md: 56,
  lg: 72,
};

const HUE: Partial<Record<AvatarTone, string>> = {
  iris: 'var(--tint-iris)',
  sage: 'var(--tint-sage)',
  apricot: 'var(--tint-apricot)',
  plum: 'var(--tint-plum)',
};

const FLAT: Partial<Record<AvatarTone, string>> = {
  neutral: 'bg-sunken text-subtle ring-1 ring-line-soft',
  user: 'bg-user-bubble text-on-user-bubble',
};

function deriveInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const second = words[1]?.[0] ?? '';

  return `${first}${second}`.toUpperCase() || '?';
}

export interface AvatarProps {
  /** Used for the initials and for the accessible name. */
  readonly name: string;
  /** Display initials, e.g. "Fn". Derived from `name` when omitted. */
  readonly initials?: string;
  /** A circular photograph. Initials remain the fallback. */
  readonly imageSrc?: string;
  readonly tone?: AvatarTone;
  readonly size?: AvatarSize;
  /**
   * Set when the avatar is the only visible identity. Left off when a name
   * sits beside it, so the name is not announced twice.
   */
  readonly label?: string;
  readonly className?: string;
}

/**
 * A circular identity mark: initials on a flat or tinted field, or a
 * photograph. Tints are mixed into the current theme surface, so one tone
 * works on ivory and on graphite without a second palette.
 *
 * Decorative by default; pass `label` when it is the only thing naming the
 * subject.
 */
export function Avatar({
  name,
  initials,
  imageSrc,
  tone = 'neutral',
  size = 'sm',
  label,
  className,
}: Readonly<AvatarProps>) {
  const hue = HUE[tone];
  const flat = FLAT[tone];
  const decorative = label === undefined;

  const style =
    hue === undefined
      ? undefined
      : {
          color: `color-mix(in oklab, ${hue} 78%, var(--ink))`,
          backgroundColor: 'var(--surface)',
          backgroundImage: [
            `radial-gradient(120% 120% at 30% 20%, color-mix(in oklab, ${hue} 22%, var(--surface)), transparent 70%)`,
            `radial-gradient(100% 100% at 80% 90%, color-mix(in oklab, ${hue} 10%, var(--surface)), transparent 65%)`,
          ].join(', '),
          boxShadow: 'inset 0 0 0 1px color-mix(in oklab, var(--ink) 9%, transparent)',
        };

  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      className={[
        'grid shrink-0 place-items-center overflow-hidden rounded-full font-display font-bold tracking-heading',
        SIZE[size],
        flat === undefined ? '' : flat,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      {imageSrc === undefined ? (
        (initials ?? deriveInitials(name))
      ) : (
        <Image
          src={imageSrc}
          alt=""
          width={PIXELS[size]}
          height={PIXELS[size]}
          className="size-full object-cover"
        />
      )}
    </span>
  );
}
