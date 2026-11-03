/**
 * Browser-side client for the auth BFF routes.
 *
 * Requests go to the same-origin `/api/auth/*` handler, which forwards to the
 * Nest API server-side. That keeps the session cookie HttpOnly on one origin
 * and avoids exposing an API base URL or any credential in client code.
 *
 * Only closed error codes cross this boundary; the UI maps them to safe copy.
 */

export interface AuthUser {
  userId: string;
  email: string;
}

interface AuthSuccessBody {
  user: AuthUser;
  csrfToken?: string;
}

export class AuthRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super(code);
    this.name = 'AuthRequestError';
    this.code = code;
    this.status = status;
  }
}

const ERROR_COPY: Readonly<Record<string, string>> = {
  invalid_credentials: 'Email or password is incorrect.',
  password_policy: 'Use at least 12 characters, and do not reuse your email address.',
  signup_unavailable:
    'We could not create an account with those details. Check your invite and try again.',
  registration_closed: 'Registration is currently closed.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  invalid_request: 'Check the form and try again.',
  auth_unavailable: 'The identity service is not available right now. Try again shortly.',
  request_failed: 'Something went wrong. Try again.',
};

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

export function authErrorMessage(error: unknown): string {
  if (error instanceof AuthRequestError) {
    return ERROR_COPY[error.code] ?? ERROR_COPY.request_failed ?? 'Something went wrong.';
  }

  return 'Habi could not reach the identity service. Try again shortly.';
}

export async function postAuth(action: string, body: unknown): Promise<AuthSuccessBody> {
  const response = await fetch(`/api/auth/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });

  const data: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    throw new AuthRequestError(readErrorCode(data) ?? 'request_failed', response.status);
  }

  return data as AuthSuccessBody;
}

export async function postRecovery(email: string): Promise<void> {
  await postAuth('recovery/request', { email });
}
