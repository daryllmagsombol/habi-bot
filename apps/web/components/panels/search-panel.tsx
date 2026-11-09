'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Button, FormMessage, TextField } from '../ui';
import { threadHref } from '../../lib/links';
import { PaginationFooter } from './pagination-footer';
import type { SearchResultView } from './types';

export interface SearchPanelProps {
  readonly botId: string;
  readonly results: readonly SearchResultView[];
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly error?: string | undefined;
  readonly onSearch: (query: string) => void;
  readonly lastQuery?: string | undefined;
  /** Cursor paging over the current query's results. */
  readonly hasMore?: boolean | undefined;
  readonly loadingMore?: boolean | undefined;
  readonly pagingError?: string | undefined;
  readonly onLoadMore?: (() => void) | undefined;
}

function Snippet({ value }: Readonly<{ value: string }>) {
  const segments: ReactNode[] = [];
  const pattern = /<mark>([\s\S]*?)<\/mark>/g;
  let cursor = 0;
  let match = pattern.exec(value);

  while (match !== null) {
    if (match.index > cursor) {
      segments.push(value.slice(cursor, match.index));
    }

    segments.push(
      <mark key={`${match.index}-mark`} className="rounded-xs bg-signal-mark px-0.5 text-ink">
        {match[1]}
      </mark>,
    );
    cursor = match.index + match[0].length;
    match = pattern.exec(value);
  }

  if (cursor < value.length) {
    segments.push(value.slice(cursor));
  }

  return <>{segments}</>;
}

/**
 * Owner-scoped message search. The backend already escapes message text and
 * wraps matches in `<mark>`; only those literal tags are interpreted here, and
 * every other character stays text. Nothing is inserted as HTML.
 */
export function SearchPanel({
  botId,
  results,
  state,
  error,
  onSearch,
  lastQuery,
  hasMore = false,
  loadingMore = false,
  pagingError,
  onLoadMore,
}: Readonly<SearchPanelProps>) {
  const id = useId();
  const [query, setQuery] = useState(lastQuery ?? '');
  const canSearch = query.trim().length > 0 && state !== 'loading';

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSearch) {
      return;
    }

    onSearch(query.trim());
  }

  return (
    <div>
      <form onSubmit={submit} className="flex flex-col gap-2">
        <TextField
          id={`${id}-search`}
          label="Search this account"
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          hint="Searches your own messages only, optionally under this Bot."
        />
        <div>
          <Button type="submit" variant="secondary" size="sm" loading={state === 'loading'}>
            Search messages
          </Button>
        </div>
      </form>

      <FormMessage error={state === 'error' ? (error ?? 'Search failed.') : undefined} />

      {state === 'loading' ? (
        <p role="status" className="mt-3 text-xs text-muted">
          Searching your messages…
        </p>
      ) : null}

      {state === 'ready' && results.length === 0 ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          No message in your account matched “{lastQuery}”.
        </p>
      ) : null}

      {results.length === 0 ? null : (
        <ul className="mt-3">
          {results.map((result) => (
            <li
              key={result.messageId}
              className="border-b border-line-soft py-2.5 first:pt-0 last:border-b-0"
            >
              <Link
                href={threadHref(botId, result.conversationId)}
                className="text-xs font-medium text-ink underline decoration-line-strong underline-offset-4 hover:no-underline"
              >
                {result.conversationTitle}
              </Link>
              <p className="mt-1 text-2xs leading-relaxed text-muted">
                <Snippet value={result.snippet} />
              </p>
              <p className="mt-1 flex items-center gap-2 text-2xs text-subtle">
                <span>{result.role === 'assistant' ? 'Bot' : 'You'}</span>
                <span className="u-figures">{result.at}</span>
              </p>
            </li>
          ))}
        </ul>
      )}

      {onLoadMore === undefined ? null : (
        <PaginationFooter
          hasMore={hasMore}
          loading={loadingMore}
          error={pagingError}
          label="Load more results"
          loadingLabel="Loading more results…"
          onLoadMore={onLoadMore}
        />
      )}
    </div>
  );
}
