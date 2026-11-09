'use client';

import { Button, Card, FormMessage, SectionHeader } from '../ui';

/** The real keys of the export document, in the order the API writes them. */
const INCLUDED: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'manifest', label: 'Schema version, export time, counts, and exclusions' },
  { key: 'profile', label: 'Account profile' },
  { key: 'ssoIdentities', label: 'Single sign-on identities' },
  { key: 'bots', label: 'Bots and their instructions' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'messages', label: 'Messages' },
  { key: 'runs', label: 'Runs' },
  { key: 'runEvents', label: 'Run events' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'artifactVersions', label: 'Every artifact version' },
  { key: 'attachments', label: 'Attachment metadata' },
  { key: 'attachmentText', label: 'Extracted attachment text' },
  { key: 'memories', label: 'Approved and proposed memories' },
  { key: 'memoryAudit', label: 'Memory approvals and audit rows' },
  { key: 'skills', label: 'Skills' },
  { key: 'skillVersions', label: 'Every skill version' },
  { key: 'usageBuckets', label: 'Usage buckets' },
  { key: 'usageReservations', label: 'Usage reservations' },
  { key: 'usageAudit', label: 'Usage limit audit' },
  { key: 'search', label: 'Search-visible message text' },
];

/** Deliberately absent from the export, stated in the API's own words. */
const EXCLUDED: readonly string[] = [
  'Password hashes and credential material',
  'Session secrets, session records, and CSRF tokens',
  'SSO PKCE verifiers, nonces, state and browser hashes, and pending authorizations',
  'Invite and password-recovery token hashes',
  'Attachment storage keys and filesystem paths',
  'Internal Run request fingerprints and idempotency keys',
];

export interface AccountExportCardProps {
  readonly mode: 'live' | 'preview';
  /** Absent in preview mode; the action is then disabled. */
  readonly onDownload?: (() => void) | undefined;
  readonly pending?: boolean | undefined;
  readonly error?: string | undefined;
  readonly status?: string | undefined;
  /** Why the action is unavailable, e.g. the preview boundary. */
  readonly disabledReason?: string | undefined;
}

/**
 * What a reader is about to download, what is deliberately left out, and the
 * one download action. The lists are the document's real section names, not a
 * summary the page made up.
 */
export function AccountExportCard({
  mode,
  onDownload,
  pending = false,
  error,
  status,
  disabledReason,
}: Readonly<AccountExportCardProps>) {
  const available = mode === 'live' && onDownload !== undefined;

  return (
    <Card as="section" padding="md" aria-labelledby="account-export-title">
      <SectionHeader as="h2" id="account-export-title" label="Export" />

      <p className="mt-3 max-w-[58ch] text-sm leading-relaxed text-muted">
        A single JSON document containing the data this account owns. It is read from one snapshot,
        so the manifest counts and the rows agree.
      </p>

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">What it contains</h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-muted">
            {INCLUDED.map((section) => (
              <li key={section.key} className="flex flex-wrap items-baseline gap-x-2">
                <code className="font-mono text-xs text-ink">{section.key}</code>
                <span>{section.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-ink">What it leaves out</h3>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted">
            {EXCLUDED.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          onClick={onDownload}
          disabled={!available || pending}
          loading={pending}
          aria-describedby="account-export-note"
        >
          Download export
        </Button>
        <p id="account-export-note" className="text-xs leading-relaxed text-subtle">
          {mode === 'preview'
            ? 'Preview mode: no API is configured on this server, so there is no account to export.'
            : 'Streamed by your browser straight to disk as habi-account-export-[timestamp].json. Nothing is emailed.'}
        </p>
      </div>

      <FormMessage
        error={error}
        status={status}
        info={mode === 'preview' ? disabledReason : undefined}
      />
    </Card>
  );
}
