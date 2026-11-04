export interface SkipLinkProps {
  /** Id (with `#`) of the focusable main landmark. */
  readonly target?: string;
  readonly children?: string;
}

/**
 * First tab stop on every page.
 *
 * Hidden by translation rather than `display: none` so it stays focusable. It is
 * a full-width bar, not a chip, so it never looks like it is covering the
 * masthead by accident. Reduced motion makes the reveal instant.
 */
export function SkipLink({ target = '#main-content', children = 'Skip to content' }: Readonly<SkipLinkProps>) {
  return (
    <a
      href={target}
      className="fixed inset-x-0 top-0 z-50 -translate-y-full border-b border-ink bg-ink px-gutter py-3 text-sm font-medium text-ink-inverse transition-transform duration-[var(--habi-duration-base)] ease-standard focus:translate-y-0 focus-visible:outline-offset-[-4px]"
    >
      {children}
    </a>
  );
}
