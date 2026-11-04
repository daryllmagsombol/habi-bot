/**
 * Shared page-level states for the two data-backed sections.
 *
 * These are deliberately not components in `components/**`: they are a route's
 * response to "the API is configured but this page cannot be rendered", which
 * is a data-selection decision, not a reusable visual. They compose the same
 * `AppBar`, `PageHeader`, `EmptyState`, and `ButtonLink` primitives as the
 * healthy screens.
 */
import { AppBar } from '../components/app-bar';
import { ButtonLink, EmptyState, PageHeader, SkipLink } from '../components/ui';
import type { ApiFailure } from '../lib/api/server';

export interface DataStateProps {
  readonly section: 'bots' | 'threads';
  readonly failure: ApiFailure;
  readonly retryHref: string;
}

function copyFor(
  failure: ApiFailure,
  section: 'bots' | 'threads',
): { title: string; description: string } {
  if (failure.reason === 'unauthorized') {
    return {
      title: section === 'bots' ? 'Sign in to see your Bots' : 'Sign in to see your threads',
      description:
        'This workspace reads the records owned by your session. It does not show an empty gallery when the session is missing.',
    };
  }

  if (failure.reason === 'invalid_config') {
    return {
      title: 'The chat API address is not valid',
      description:
        'The server is configured with an API address that is not a usable http or https URL. The sample preview is not shown while an API is configured.',
    };
  }

  if (failure.reason === 'forbidden') {
    return {
      title: 'This request was refused',
      description:
        'The API refused the request for this session. Nothing was replaced with sample data.',
    };
  }

  if (failure.reason === 'not_found') {
    return {
      title: 'That record is not available',
      description:
        'The API did not return this record for your session. Nothing was replaced with sample data.',
    };
  }

  return {
    title: 'The chat API is not reachable',
    description:
      'Habi could not load this page from the API. The sample preview is not shown when an API is configured, so this is an error state rather than invented content.',
  };
}

export function DataStatePage({ section, failure, retryHref }: Readonly<DataStateProps>) {
  const copy = copyFor(failure, section);
  const needsSignIn = failure.reason === 'unauthorized';

  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink />
      <AppBar section={section} counts={{ bots: 0, threads: 0 }} mode="live" />

      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-wide flex-1 px-4 py-10 focus:outline-none sm:px-6 sm:py-14"
      >
        <PageHeader
          title={copy.title}
          description={copy.description}
          actions={
            <>
              {needsSignIn ? (
                <ButtonLink href="/login">Sign in</ButtonLink>
              ) : (
                <ButtonLink href={retryHref}>Try again</ButtonLink>
              )}
              <ButtonLink href="/start" variant="secondary">
                Identity screens
              </ButtonLink>
            </>
          }
        />

        <EmptyState
          headingLevel={2}
          className="mt-10"
          title={needsSignIn ? 'No records are shown without a session.' : 'No sample data here.'}
          description={
            needsSignIn
              ? 'Signing in returns you to the workspace with your own Bots and threads.'
              : 'If the API stays unavailable, check the server-side API configuration instead of treating this screen as empty.'
          }
        />
      </main>
    </div>
  );
}
