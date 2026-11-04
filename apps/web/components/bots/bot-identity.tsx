import type { ReactNode } from 'react';
import { Avatar, ChevronLeftIcon, IconButtonLink, type AvatarTone } from '../ui';

export interface BotIdentityProps {
  readonly backHref: string;
  readonly backLabel?: string;
  readonly name: string;
  readonly initials: string;
  readonly tone?: AvatarTone;
  /** The one-line selection summary, e.g. "No tools · 2 of 3 memories selected". */
  readonly summary: ReactNode;
  /** Edit and create controls; the page decides whether they are wired. */
  readonly actions?: ReactNode;
}

/**
 * The Bot page header: a back control, the Bot's mark and name, the selection
 * summary, and the page actions.
 *
 * On a phone the actions move to their own full-width row; on a wide screen
 * they sit at the far end of the identity line. The heading is the page's only
 * `h1`.
 */
export function BotIdentity({
  backHref,
  backLabel = 'Back to all bots',
  name,
  initials,
  tone = 'neutral',
  summary,
  actions,
}: Readonly<BotIdentityProps>) {
  return (
    <div className="flex flex-col gap-3 pt-6 pb-3 sm:flex-row sm:items-center sm:pt-10 sm:pb-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <IconButtonLink
          href={backHref}
          label={backLabel}
          variant="surface"
          icon={<ChevronLeftIcon size={16} />}
        />

        <Avatar name={name} initials={initials} tone={tone} size="sm" />

        <div className="min-w-0">
          <h1 className="truncate text-[1.125rem] leading-tight font-semibold tracking-heading text-ink lg:text-[1.375rem]">
            {name}
          </h1>
          <p className="mt-0.5 text-2xs text-subtle">{summary}</p>
        </div>
      </div>

      {actions === undefined ? null : (
        <div className="grid grid-cols-2 gap-2 sm:ml-auto sm:flex">{actions}</div>
      )}
    </div>
  );
}
