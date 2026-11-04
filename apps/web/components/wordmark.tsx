import Link from 'next/link';

export interface WordmarkProps {
  readonly href?: string;
  /** Spoken name; the seed square is decorative. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * The wordmark: a seed square and "Habi".
 *
 * The square is the same ink tile in the workspace bar and on the public
 * masthead, so the two shells read as one product. The link always clears the
 * 44px target even though the mark is small.
 */
export function Wordmark({
  href = '/bots',
  label = 'Habi, all bots',
  className,
}: Readonly<WordmarkProps>) {
  return (
    <Link
      href={href}
      aria-label={label}
      className={['u-brand inline-flex min-h-11 shrink-0 items-center gap-2 text-ink', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        aria-hidden="true"
        className="grid size-5.5 place-items-center rounded-xs bg-ink text-[0.6875rem] font-bold tracking-normal text-ink-inverse"
      >
        H
      </span>
      Habi
    </Link>
  );
}
