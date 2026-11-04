/**
 * Server-only API configuration.
 *
 * `HABI_API_URL` is read on the server and never becomes a client bundle value:
 * it is not `NEXT_PUBLIC_`, and no page or route echoes it. Unset means the
 * sample-data preview; set means the real API. An unparsable value is a
 * configuration error, not a reason to fall back to the preview.
 */

export type ApiConfig =
  | { readonly kind: 'unset' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'configured'; readonly origin: string };

export function readApiConfig(): ApiConfig {
  const raw = process.env.HABI_API_URL?.trim();

  if (raw === undefined || raw.length === 0) {
    return { kind: 'unset' };
  }

  try {
    const url = new URL(raw);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { kind: 'invalid' };
    }

    return { kind: 'configured', origin: url.origin };
  } catch {
    return { kind: 'invalid' };
  }
}

/** True whenever an API base URL is configured, even if it is unreachable. */
export function isApiConfigured(): boolean {
  return readApiConfig().kind !== 'unset';
}
