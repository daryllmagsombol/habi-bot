/**
 * Browser calls for the account export and deletion.
 *
 * Both go to the same-origin `/api/account` BFF. The backend origin, the
 * session cookie and the CSRF token never cross into this module; it only knows
 * relative paths and the readable `habi_csrf` value the session layer
 * publishes.
 *
 * Errors reuse the chat surface's closed-code vocabulary (`ChatRequestError`
 * and `chatErrorMessage`), so the page never invents a second error language.
 */
import { ChatRequestError, readCsrfToken } from './browser';

export interface AccountRemovalCounts {
  readonly attachments: number;
  readonly attachmentText: number;
  readonly memories: number;
  readonly memoryAudit: number;
  readonly artifacts: number;
  readonly artifactVersions: number;
  readonly messages: number;
  readonly skills: number;
  readonly skillVersions: number;
  readonly runs: number;
  readonly runEvents: number;
  readonly conversations: number;
  readonly bots: number;
  readonly usageBuckets: number;
  readonly usageReservations: number;
  readonly usageAudit: number;
  readonly ssoIdentities: number;
  readonly ssoPending: number;
  readonly passwordResetTokens: number;
}

export interface AccountBackupRetention {
  readonly encrypted: true;
  readonly encryption: string;
  readonly policy: string;
  readonly maximumDays: number;
  readonly disclosure: string;
}

/** `DELETE /api/account` (200). The session is revoked by this call. */
export interface AccountDeletionResult {
  readonly deleted: true;
  readonly accountId: string;
  readonly deletedAt: string;
  readonly alreadyDeleted: boolean;
  readonly sessionsRevoked: number;
  readonly removed: AccountRemovalCounts;
  readonly backupRetention: AccountBackupRetention;
}

function readErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const error = (value as { error?: unknown }).error;

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : undefined;
}

function filenameFrom(disposition: string | null): string | undefined {
  if (disposition === null) {
    return undefined;
  }

  const match = /filename="?([^";]+)"?/i.exec(disposition);

  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();

  // The browser starts the save synchronously; release the object URL after.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Reads the export through the BFF so a 401 or 5xx becomes a typed error the
 * page can announce, rather than a navigation to a JSON error document. A
 * plain `<a download>` would be shorter but would silently hand the reader a
 * JSON error file when the session has ended.
 */
export async function downloadExport(): Promise<{ readonly filename: string }> {
  let response: Response;

  try {
    response = await fetch('/api/account/export', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ChatRequestError('api_unavailable', 0);
  }

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);

    throw new ChatRequestError(readErrorCode(body) ?? 'request_failed', response.status);
  }

  const filename =
    filenameFrom(response.headers.get('content-disposition')) ?? 'habi-account-export.json';

  saveBlob(await response.blob(), filename);

  return { filename };
}

/** Deletes the account. The BFF relays the API's removal counts and disclosure. */
export async function deleteAccount(input: {
  readonly confirm: string;
}): Promise<AccountDeletionResult> {
  const csrfToken = readCsrfToken();

  if (csrfToken === undefined) {
    throw new ChatRequestError('csrf_invalid', 403);
  }

  let response: Response;

  try {
    response = await fetch('/api/account', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ confirm: input.confirm }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ChatRequestError('api_unavailable', 0);
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new ChatRequestError(readErrorCode(body) ?? 'request_failed', response.status);
  }

  if (body === undefined) {
    throw new ChatRequestError('request_failed', response.status);
  }

  return body as AccountDeletionResult;
}
