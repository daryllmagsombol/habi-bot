import { Button } from '../ui';

export interface PaginationFooterProps {
  /** `false` means `nextCursor` was null; nothing more is fetched. */
  readonly hasMore: boolean;
  readonly loading?: boolean;
  readonly error?: string | undefined;
  /** Button label, e.g. "Load more memories". */
  readonly label: string;
  readonly loadingLabel?: string;
  readonly onLoadMore: () => void;
  readonly className?: string;
}

/**
 * One cursor page's "load more" control.
 *
 * The parent appends the next page to its existing list, so this control never
 * owns or replaces the rows above it. While a page is in flight the button is
 * busy and a polite live region says so; a failed page is announced assertively
 * and the already-loaded rows stay visible.
 */
export function PaginationFooter({
  hasMore,
  loading = false,
  error,
  label,
  loadingLabel = 'Loading more…',
  onLoadMore,
  className,
}: Readonly<PaginationFooterProps>) {
  if (!hasMore) {
    return null;
  }

  return (
    <div className={['mt-3 flex flex-col gap-2', className].filter(Boolean).join(' ')}>
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={loading}
          onClick={onLoadMore}
        >
          {label}
        </Button>
      </div>

      <p role="status" aria-live="polite" className="text-2xs leading-relaxed text-subtle">
        {loading ? loadingLabel : 'More results are available.'}
      </p>

      {error === undefined ? null : (
        <p role="alert" className="text-xs leading-relaxed text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
