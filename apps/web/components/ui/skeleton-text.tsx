import { Skeleton } from './skeleton';

export interface SkeletonTextProps {
  readonly lines?: number;
  /** Width of the last line, so the block reads as a paragraph. */
  readonly lastLine?: string;
  readonly className?: string;
}

/** A paragraph-shaped set of skeleton lines. */
export function SkeletonText({
  lines = 3,
  lastLine = 'w-2/3',
  className,
}: Readonly<SkeletonTextProps>) {
  return (
    <span className={['flex flex-col gap-2', className].filter(Boolean).join(' ')}>
      {Array.from({ length: Math.max(1, lines) }, (_, index) => {
        const isLast = index === Math.max(1, lines) - 1;

        return <Skeleton key={index} className={`h-3 ${isLast ? lastLine : 'w-full'}`} />;
      })}
    </span>
  );
}
