'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { AccountDeletionResult, AccountRemovalCounts } from '../../lib/api/account';
import { formatWhen } from '../../lib/api/format';
import { Button, ButtonLink, Card, FormMessage, SectionHeader, TextField } from '../ui';

/**
 * The disclosure is fixed copy from the account API. It is shown before the
 * reader types anything and again, verbatim, in the result.
 */
export const ACCOUNT_BACKUP_DISCLOSURE =
  "A copy of this account's data survives in age-encrypted backups created before this deletion until those archives age out under the 7 daily / 4 weekly / 6 monthly retention policy — up to 184 days. Nothing is purged from an existing archive.";

const REMOVED_LABELS: readonly (readonly [keyof AccountRemovalCounts, string])[] = [
  ['bots', 'Bots'],
  ['conversations', 'Conversations'],
  ['messages', 'Messages'],
  ['runs', 'Runs'],
  ['runEvents', 'Run events'],
  ['artifacts', 'Artifacts'],
  ['artifactVersions', 'Artifact versions'],
  ['attachments', 'Attachments'],
  ['attachmentText', 'Extracted attachment text'],
  ['memories', 'Memories'],
  ['memoryAudit', 'Memory audit rows'],
  ['skills', 'Skills'],
  ['skillVersions', 'Skill versions'],
  ['usageBuckets', 'Usage buckets'],
  ['usageReservations', 'Usage reservations'],
  ['usageAudit', 'Usage audit rows'],
  ['ssoIdentities', 'Single sign-on identities'],
  ['ssoPending', 'Pending single sign-on authorizations'],
  ['passwordResetTokens', 'Password reset token hashes'],
];

export interface AccountDeleteCardProps {
  /** The signed-in account's email; absent in preview mode. */
  readonly email?: string | undefined;
  /** Absent in preview mode; the action is then disabled. */
  readonly onDelete?: ((confirmation: string) => void) | undefined;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  readonly result?: AccountDeletionResult | undefined;
  /** Why the action is unavailable, e.g. the preview boundary. */
  readonly disabledReason?: string | undefined;
}

function removedRows(result: AccountDeletionResult): readonly (readonly [string, number])[] {
  return REMOVED_LABELS.flatMap(([key, label]) => {
    const count = result.removed[key];

    return count > 0 ? ([[label, count]] as const) : [];
  });
}

function deletionAnnouncement(result: AccountDeletionResult): string {
  const sessions =
    result.sessionsRevoked === 1
      ? '1 live session was revoked'
      : `${result.sessionsRevoked} live sessions were revoked`;

  return result.alreadyDeleted
    ? `This account was already deleted. ${sessions}, including this one.`
    : `Account deleted. ${sessions}, including this one.`;
}

function DeletionResult({ result }: Readonly<{ result: AccountDeletionResult }>) {
  const rows = removedRows(result);
  const sessions =
    result.sessionsRevoked === 1
      ? '1 live session was revoked, including this one.'
      : `${result.sessionsRevoked} live sessions were revoked, including this one.`;

  return (
    <div className="mt-6">
      <h3 className="text-title tracking-heading text-ink">
        {result.alreadyDeleted ? 'This account was already deleted' : 'Account deleted'}
      </h3>

      <p className="mt-2 max-w-[58ch] text-sm leading-relaxed text-muted">
        {result.alreadyDeleted
          ? 'The account had already been removed. Any residue was deleted again and the first deletion instant is reported below.'
          : 'The live database no longer holds this account or its owned rows.'}{' '}
        Deleted at {formatWhen(result.deletedAt)}; account id{' '}
        <code className="font-mono text-xs text-ink">{result.accountId}</code>.
      </p>

      <p className="mt-2 text-sm leading-relaxed text-muted">
        {sessions}{' '}
        <ButtonLink href="/login" variant="ghost" size="sm">
          Sign in to another account
        </ButtonLink>
      </p>

      <h3 className="mt-6 text-sm font-semibold text-ink">What was removed</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">No rows remained to remove.</p>
      ) : (
        <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {rows.map(([label, count]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-line py-1.5">
              <dt className="text-muted">{label}</dt>
              <dd className="u-figures text-ink">{count}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-6 max-w-[62ch] text-xs leading-relaxed text-subtle">
        {result.backupRetention.disclosure}
      </p>
    </div>
  );
}

/**
 * The deliberate two-step deletion: the reader types the account email, which
 * is the only thing that enables the destructive control. The outcome is a
 * named result region — what was removed, that every session was revoked, and
 * the backup retention statement — not a transient toast.
 */
export function AccountDeleteCard({
  email,
  onDelete,
  pending = false,
  error,
  status,
  result,
  disabledReason,
}: Readonly<AccountDeleteCardProps>) {
  const baseId = useId();
  const [confirmation, setConfirmation] = useState('');
  const expected = email?.trim() ?? '';
  const matches =
    expected.length > 0 && confirmation.trim().toLowerCase() === expected.toLowerCase();
  const available = onDelete !== undefined && expected.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!matches || pending || onDelete === undefined) {
      return;
    }

    onDelete(confirmation.trim());
  }

  return (
    <Card as="section" padding="md" aria-labelledby="account-delete-title">
      <SectionHeader as="h2" id="account-delete-title" label="Delete account" />

      {/* Present before the result so the announcement has a stable live region. */}
      <div aria-live="polite" className="sr-only">
        {result === undefined ? '' : deletionAnnouncement(result)}
      </div>

      {result === undefined ? (
        <>
          <p className="mt-3 max-w-[58ch] text-sm leading-relaxed text-muted">
            Deletion removes this account and every row it owns from the live database, then revokes
            all of its sessions. It cannot be undone.
          </p>

          <p className="mt-4 max-w-[62ch] border-l-2 border-danger-line pl-4 text-sm leading-relaxed text-muted">
            {ACCOUNT_BACKUP_DISCLOSURE}
          </p>

          <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
            <TextField
              id={`${baseId}-confirm`}
              label="Type your account email to confirm"
              type="email"
              autoComplete="off"
              spellCheck={false}
              inputMode="email"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              disabled={!available || pending}
              hint={
                expected.length === 0 ? (
                  'The account email appears here when an API and a session are available.'
                ) : (
                  <>
                    Your account email is{' '}
                    <strong className="font-semibold text-ink">{expected}</strong>. Type it exactly;
                    the button stays disabled until it matches.
                  </>
                )
              }
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                variant="danger"
                size="sm"
                disabled={!matches || pending || !available}
                loading={pending}
              >
                Delete account permanently
              </Button>
              <span className="text-xs leading-relaxed text-subtle">
                {matches ? 'The confirmation matches.' : 'Nothing is deleted until this matches.'}
              </span>
            </div>
          </form>

          <FormMessage
            error={error}
            status={status}
            info={onDelete === undefined ? disabledReason : undefined}
          />
        </>
      ) : (
        <DeletionResult result={result} />
      )}
    </Card>
  );
}
