export interface SkeletonProps {
  readonly className?: string;
}

/**
 * A reserved block for content that is still loading.
 *
 * Flat sunken fill, no shimmer sweep: the direction has no gradients. Pulse is
 * motion-safe only, so a reader who prefers reduced motion sees a stable block
 * instead of a flashing one. Give the surrounding layout a fixed height so the
 * swap to real content does not shift anything.
 */
export function Skeleton({ className }: Readonly<SkeletonProps>) {
  return (
    <span
      aria-hidden="true"
      className={['block rounded-xs bg-sunken motion-safe:animate-pulse', className]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

export interface SkeletonTextProps {
  readonly lines?: number;
  /** Width of the last line, so the block reads as a paragraph. */
  readonly lastLine?: string;
  readonly className?: string;
}

export function SkeletonText({ lines = 3, lastLine = 'w-2/3', className }: Readonly<SkeletonTextProps>) {
  return (
    <span className={['flex flex-col gap-2', className].filter(Boolean).join(' ')}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => {
        const isLast = index === Math.max(1, lines) - 1;

        return <Skeleton key={index} className={`h-3 ${isLast ? lastLine : 'w-full'}`} />;
      })}
    </span>
  );
}
