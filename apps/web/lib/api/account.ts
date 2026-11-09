/**
 * Browser calls for the account profile, export and deletion.
 *
 * Every request goes to the same-origin `/api/account` BFF. The backend origin,
 * the session cookie and the CSRF token never cross into this module; it only
 * knows relative paths and the readable `habi_csrf` value the session layer
 * publishes. The export itself is a navigation, not a buffered fetch, so the
 * browser can stream it to disk.
 *
 * Errors reuse the chat surface's closed-code vocabulary (`ChatRequestError`
 * and `chatErrorMessage`), so the page never invents a second error language.
 */
import { ChatRequestError, readCsrfToken } from './browser';
import type { AccountProfileDto } from './types';

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

const ACCOUNT_PATH = '/api/account';
/** The BFF route that streams the export with its `content-disposition`. */
export const EXPORT_PATH = '/api/account/export';

/**
 * `GET /api/account` through the BFF: the lightweight profile read.
 *
 * It is cheap, it is the same shape the account page renders, and a 401 is a
 * typed error rather than a navigation target. The export action reuses it as
 * a preflight.
 */
export async function readAccountProfile(): Promise<AccountProfileDto> {
  let response: Response;

  try {
    response = await fetch(ACCOUNT_PATH, {
      method: 'GET',
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

  const account =
    typeof body === 'object' && body !== null
      ? (body as { account?: unknown }).account
      : undefined;

  if (
    typeof account !== 'object' ||
    account === null ||
    typeof (account as { email?: unknown }).email !== 'string'
  ) {
    throw new ChatRequestError('request_failed', response.status);
  }

  return account as AccountProfileDto;
}

/**
 * Starts the export through a direct navigation, not a buffered fetch.
 *
 * Buffering the whole document as a Blob costs memory proportional to the
 * account, while the BFF route already relays `content-disposition` and streams
 * the upstream body to the browser, which writes it to disk.
 *
 * A bare `<a download>` was rejected earlier because a 401 or 5xx would
 * navigate the reader to a raw JSON error document. The honesty fix is the
 * cheap `GET /api/account` preflight: if the session or API is unavailable it
 * throws a typed error and the page renders its existing error state; nothing
 * navigates. Only a successful preflight triggers the download.
 */
export async function downloadExport(): Promise<{ readonly started: true }> {
  await readAccountProfile();

  window.location.replace(EXPORT_PATH);

  return { started: true };
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
