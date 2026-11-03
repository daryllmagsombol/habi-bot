/**
 * Deterministic text normalization, bounds, and chunking for H-027 (#27).
 *
 * Normalization is deliberately small and repeatable:
 *   1. decode as strict UTF-8 (a BOM is consumed, invalid bytes are refused);
 *   2. NUL is refused because PostgreSQL text cannot store it and a half-read
 *      document must not be reported as complete;
 *   3. every CRLF or lone CR becomes LF;
 *   4. NFKC folds compatibility forms (full-width Latin, ligatures, and so on).
 *
 * Offsets therefore describe the normalized string, not the uploaded bytes.
 * Re-running extraction over the same verified bytes yields the same text and
 * the same offsets, which is what makes citations exact.
 *
 * Chunking is sentence-aware:
 *   - a chunk targets `CHUNK_CHARACTERS` UTF-16 code units;
 *   - the cut prefers the last line break, then the last sentence terminator
 *     followed by whitespace, then the last whitespace, and only then a hard
 *     cut, all inside the second half of the window so chunks stay useful;
 *   - the next chunk starts `CHUNK_OVERLAP_CHARACTERS` before the previous end,
 *     so a sentence crossing a boundary is present in at least one chunk;
 *   - cuts never split a surrogate pair.
 *
 * All extracted text is untrusted data. Nothing here interprets it.
 */
import { createHash } from 'node:crypto';
import { ExtractionError } from './errors.js';
import type { CitationRange } from './types.js';

/** Largest normalized document this lane will store chunks for. */
export const MAX_EXTRACTED_CHARACTERS = 1_000_000;

/** Target chunk width in UTF-16 code units. */
export const CHUNK_CHARACTERS = 1200;

/** How much of the previous chunk the next chunk repeats. */
export const CHUNK_OVERLAP_CHARACTERS = 150;

/** Largest passage one citation may quote, so one call stays bounded. */
export const MAX_CITATION_CHARACTERS = 4000;

/** A cut is not taken before this fraction of the target window. */
const MIN_CHUNK_CUT = Math.floor(CHUNK_CHARACTERS / 2);

const WHITESPACE = /\s/u;

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Moves a cut left when it would land between a surrogate pair's halves. */
function cutBackward(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }

  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);

  return isHighSurrogate(previous) && isLowSurrogate(next) ? index - 1 : index;
}

/** Moves a start right when it would land between a surrogate pair's halves. */
function advanceForward(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }

  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);

  return isHighSurrogate(previous) && isLowSurrogate(current) ? index + 1 : index;
}

function isSentenceTerminator(character: string): boolean {
  return character === '.' || character === '!' || character === '?' || character === '…';
}

/**
 * Strict UTF-8 decode. A document that is not valid UTF-8 text is refused as
 * `invalid_content`; it is never decoded with replacement characters, because a
 * lossy read would make offsets and citations lie.
 */
export function decodeExtractedText(content: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new ExtractionError('invalid_content');
  }
}

/** Applies line-ending and NFKC normalization. NUL is refused, not stripped. */
export function normalizeExtractedText(value: string): string {
  if (value.includes('\u0000')) {
    throw new ExtractionError('invalid_content');
  }

  return value.replace(/\r\n?/g, '\n').normalize('NFKC');
}

/**
 * Decodes, normalizes, and applies the document bounds. Empty or
 * whitespace-only files are `empty_content`; a document that normalizes past
 * `MAX_EXTRACTED_CHARACTERS` is `content_too_large` rather than a partial read.
 */
export function readNormalizedDocument(content: Buffer): string {
  const text = normalizeExtractedText(decodeExtractedText(content));

  if (text.trim().length === 0) {
    throw new ExtractionError('empty_content');
  }

  if (text.length > MAX_EXTRACTED_CHARACTERS) {
    throw new ExtractionError('content_too_large');
  }

  return text;
}

/** Finds one cut end in `(start, start + CHUNK_CHARACTERS]`. */
function findChunkEnd(text: string, start: number): number {
  const target = Math.min(start + CHUNK_CHARACTERS, text.length);

  if (target === text.length) {
    return target;
  }

  const minimum = Math.min(start + MIN_CHUNK_CUT, target);

  // The last line break or sentence end wins. Scanning backward keeps the
  // chunk close to the target width instead of cutting at the first sentence.
  for (let index = target; index > minimum; index -= 1) {
    const character = text[index - 1];

    if (character === undefined) {
      continue;
    }

    if (character === '\n') {
      return cutBackward(text, index);
    }

    if (isSentenceTerminator(character)) {
      const following = text[index];

      if (following === undefined || WHITESPACE.test(following)) {
        return cutBackward(text, index);
      }
    }
  }

  for (let index = target; index > start + 1; index -= 1) {
    const character = text[index - 1];

    if (character !== undefined && WHITESPACE.test(character)) {
      return cutBackward(text, index);
    }
  }

  return cutBackward(text, target);
}

/**
 * Splits normalized text into deterministic, overlapping, sentence-aware spans.
 * The returned text is always the exact slice at the returned offsets, and a
 * document with no characters produces no spans.
 */
export function chunkText(text: string): CitationRange[] {
  const chunks: CitationRange[] = [];
  let start = 0;

  while (start < text.length) {
    const end = findChunkEnd(text, start);
    chunks.push({ startOffset: start, endOffset: end });

    if (end >= text.length) {
      break;
    }

    start = advanceForward(text, end - CHUNK_OVERLAP_CHARACTERS);
  }

  return chunks;
}

/** Throws `invalid_range` unless the range is an integer half-open span inside the document. */
export function validateCitationRange(
  range: CitationRange,
  characterCount: number,
): CitationRange {
  if (typeof range !== 'object' || range === null) {
    throw new ExtractionError('invalid_range');
  }

  const { startOffset, endOffset } = range;

  if (
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset <= startOffset ||
    endOffset > characterCount ||
    endOffset - startOffset > MAX_CITATION_CHARACTERS
  ) {
    throw new ExtractionError('invalid_range');
  }

  return { startOffset, endOffset };
}

/**
 * Stable citation id. It repeats only the attachment id and the exact passage
 * coordinates, plus a short digest of the quote so the id changes if the quote
 * ever did. It carries no filename, owner, or content beyond the quote digest.
 */
export function buildCitationId(
  attachmentId: string,
  startOffset: number,
  endOffset: number,
  text: string,
): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

  return `cite:${attachmentId}:${startOffset}:${endOffset}:${digest}`;
}
