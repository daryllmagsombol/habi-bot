import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppBar } from '../../components/app-bar';
import { AccountDeleteCard, AccountExportCard } from '../../components/account';
import {
  ButtonLink,
  Container,
  EmptyState,
  PageHeader,
  SkipLink,
  Stack,
} from '../../components/ui';
import { readApiConfig } from '../../lib/api/config';
import { AccountLive } from './account-live';
import { fetchAccountProfile } from './session';

export const metadata: Metadata = {
  title: 'Account',
  description: 'Export or delete the data held for your Habi account.',
};

/**
 * Configuration and the session cookie are read per request, so the same build
 * can render the honest preview, the signed-in page, and the sign-in state.
 */
export const dynamic = 'force-dynamic';

interface FrameProps {
  readonly mode: 'preview' | 'live';
  readonly children: ReactNode;
}

function AccountFrame({ mode, children }: Readonly<FrameProps>) {
  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <AppBar section="account" mode={mode} />

      <main id="main-content" tabIndex={-1} className="flex-1 focus:outline-none">
        <Container size="reading" className="py-10 sm:py-14">
          {children}
        </Container>
      </main>
    </div>
  );
}

function PreviewAccountPage() {
  return (
    <AccountFrame mode="preview">
      <PageHeader
        title="Account"
        description="Export or delete the data this server holds for your account. Preview mode is active."
      />

      <p className="mt-4 max-w-[58ch] text-sm leading-relaxed text-muted">
        No API is configured on this server, so this page cannot read, download, or delete an
        account. Both actions are disabled, and nothing on this page is sample account data.
      </p>

      <Stack gap={6} className="mt-8">
        <AccountExportCard
          mode="preview"
          disabledReason="Preview mode: no API is configured, so there is no account export to download."
        />
        <AccountDeleteCard disabledReason="Preview mode: no API is configured, so no account can be deleted." />
      </Stack>
    </AccountFrame>
  );
}

function SignInAccountPage() {
  return (
    <AccountFrame mode="live">
      <PageHeader
        title="Sign in to manage your account"
        description="The account page reads and deletes only the records owned by your session. It does not show an empty account when the session is missing."
        actions={<ButtonLink href="/login">Sign in</ButtonLink>}
      />

      <EmptyState
        headingLevel={2}
        className="mt-8"
        title="No account is loaded without a session."
        description="Signing in returns you here with your own export and deletion controls."
      />
    </AccountFrame>
  );
}

function UnavailableAccountPage({ invalid }: Readonly<{ invalid: boolean }>) {
  return (
    <AccountFrame mode="live">
      <PageHeader
        title={invalid ? 'The account API address is not valid' : 'Account settings are not available'}
        description={
          invalid
            ? 'The server is configured with an API address that is not a usable http or https URL. The preview is not shown while an API is configured.'
            : 'Habi could not read this account from the API. This is an error state, not an empty account; nothing was exported or deleted.'
        }
        actions={
          <>
            <ButtonLink href="/account">Try again</ButtonLink>
            <ButtonLink href="/bots" variant="secondary">
              Back to bots
            </ButtonLink>
          </>
        }
      />

      <EmptyState
        headingLevel={2}
        className="mt-8"
        title={invalid ? 'Fix the server-side API configuration.' : 'No account data is shown.'}
        description={
          invalid
            ? 'Correct the configured API origin and reload this page.'
            : 'If the API stays unavailable, check the server-side API configuration instead of treating this as a deleted account.'
        }
      />
    </AccountFrame>
  );
}

export default async function AccountPage() {
  const config = readApiConfig();

  if (config.kind === 'unset') {
    return <PreviewAccountPage />;
  }

  if (config.kind === 'invalid') {
    return <UnavailableAccountPage invalid />;
  }

  const profile = await fetchAccountProfile();

  if (!profile.ok) {
    return profile.reason === 'unauthorized' ? (
      <SignInAccountPage />
    ) : (
      <UnavailableAccountPage invalid={false} />
    );
  }

  return (
    <AccountFrame mode="live">
      <PageHeader
        title="Account"
        description="Export everything this account owns as one JSON document, or delete the account and every session it holds."
      />

      <div className="mt-8">
        <AccountLive email={profile.account.email} />
      </div>
    </AccountFrame>
  );
}
