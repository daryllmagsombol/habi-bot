/**
 * A route-level loading shell for the data-backed screens.
 *
 * It reserves the shape of the page instead of showing a spinner over empty
 * space, and it is `aria-busy` so assistive technology knows the content is
 * still arriving. Motion is the `Skeleton` primitive's, which is already
 * motion-safe.
 */
import { Skeleton, SkeletonText, SkipLink } from '../components/ui';

export interface LoadingShellProps {
  readonly label: string;
  readonly rows?: number;
}

export function LoadingShell({ label, rows = 3 }: Readonly<LoadingShellProps>) {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <div className="flex min-h-14 items-center border-b border-line px-4 sm:px-6">
        <Skeleton className="h-5 w-16" />
      </div>

      <main
        id="main-content"
        tabIndex={-1}
        aria-busy="true"
        className="mx-auto w-full max-w-wide flex-1 px-4 pb-16 focus:outline-none sm:px-6 lg:pb-20"
      >
        <p className="sr-only" role="status" aria-live="polite">
          {label}…
        </p>

        <div className="pt-6 pb-6 sm:pt-9 sm:pb-7">
          <Skeleton className="h-9 w-52" />
          <SkeletonText className="mt-4 max-w-[46ch]" lines={2} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="rounded-lg border border-line-soft p-4">
              <Skeleton className="h-10 w-10 rounded-md" />
              <SkeletonText className="mt-4" lines={3} />
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
