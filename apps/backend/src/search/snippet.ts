/**
 * HTML-safety for search excerpts.
 *
 * `ts_headline` runs in PostgreSQL with private delimiters around each matching
 * lexeme. The returned text still contains the raw message content, so this
 * module re-escapes every content segment and rebuilds the excerpt with real
 * `<mark>`/`</mark>` tags. Message content can therefore never introduce an
 * element, attribute, or script: only the two tags this module emits exist in
 * the output, and everything else from the message is inert text.
 *
 * The delimiters are configurable so the SQL side and this parser stay in sync.
 */
export const SNIPPET_HIT_START = '@@HABI_HIT@@';
export const SNIPPET_HIT_END = '@@/HABI_HIT@@';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/**
 * Converts a `ts_headline` fragment into escaped HTML with `<mark>` around each
 * hit. An unmatched delimiter is tolerated: the remainder is escaped as plain
 * text rather than emitted raw.
 */
export function toSnippet(headline: string): string {
  const parts: string[] = [];
  let remainder = headline;

  for (;;) {
    const start = remainder.indexOf(SNIPPET_HIT_START);

    if (start === -1) {
      parts.push(escapeHtml(remainder));
      break;
    }

    const end = remainder.indexOf(SNIPPET_HIT_END, start + SNIPPET_HIT_START.length);

    if (end === -1) {
      parts.push(escapeHtml(remainder));
      break;
    }

    parts.push(escapeHtml(remainder.slice(0, start)));
    parts.push(
      `<mark>${escapeHtml(
        remainder.slice(start + SNIPPET_HIT_START.length, end),
      )}</mark>`,
    );
    remainder = remainder.slice(end + SNIPPET_HIT_END.length);
  }

  return parts.join('').replace(/\s+/g, ' ').trim();
}
