'use client';

import { useState } from 'react';
import { AccountDeleteCard, AccountExportCard } from '../../components/account';
import { Stack } from '../../components/ui';
import {
  deleteAccount,
  downloadExport,
  type AccountDeletionResult,
} from '../../lib/api/account';
import { chatErrorMessage } from '../../lib/api/browser';

export interface AccountLiveProps {
  /** The signed-in account's email, read server-side from `/api/account`. */
  readonly email: string;
}

/**
 * The account page coordinator. It owns the BFF calls and their outcome; the
 * cards only render props and report intent.
 */
export function AccountLive({ email }: Readonly<AccountLiveProps>) {
  const [exportPending, setExportPending] = useState(false);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const [exportStatus, setExportStatus] = useState<string | undefined>(undefined);

  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<AccountDeletionResult | undefined>(undefined);

  function handleDownload() {
    setExportPending(true);
    setExportError(undefined);
    setExportStatus(undefined);

    void downloadExport()
      .then(() =>
        setExportStatus(
          'The export download has started. Your browser streams it straight to disk.',
        ),
      )
      .catch((error: unknown) => setExportError(chatErrorMessage(error)))
      .finally(() => setExportPending(false));
  }

  function handleDelete(confirmation: string) {
    setDeletePending(true);
    setDeleteError(undefined);

    void deleteAccount({ confirm: confirmation })
      .then((value) => setResult(value))
      .catch((error: unknown) => setDeleteError(chatErrorMessage(error)))
      .finally(() => setDeletePending(false));
  }

  return (
    <Stack gap={6}>
      <AccountExportCard
        mode="live"
        onDownload={handleDownload}
        pending={exportPending}
        error={exportError}
        status={exportStatus}
      />

      <AccountDeleteCard
        email={email}
        onDelete={handleDelete}
        pending={deletePending}
        error={deleteError}
        result={result}
      />
    </Stack>
  );
}
