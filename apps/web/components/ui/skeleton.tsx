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
