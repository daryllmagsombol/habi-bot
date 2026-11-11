/**
 * Structured JSON-lines logger for H-013 (#13).
 *
 * One line per event on stdout: `{ts, level, service, event, ...safeFields}`.
 * Every field value passes through `redact` before serialization, so the
 * logger itself enforces the "no prompts or secrets by default" boundary
 * rather than relying on each caller to remember it:
 *
 *   - keys matching credentials/headers are replaced wholesale;
 *   - prompt/message/body keys are replaced wholesale;
 *   - plain objects are walked recursively, cycle-safe and depth-bounded;
 *   - `Error` values become `{name, code, message}` with a scrubbed message,
 *     never a stack;
 *   - values JSON cannot represent are stringified or marked, never thrown.
 *
 * The log line is additionally bounded so a single oversized field cannot
 * fill a shared VM's disk. Callers must still avoid putting user content in
 * event names or error messages; a message cannot be classified as a prompt.
 *
 * Not product Bot capability and unrelated to the CI review runtime.
 */
import { Inject, Injectable } from '@nestjs/common';
import { OBSERVABILITY_CONFIG } from './observability-config.js';
import type { LogLevel, ObservabilityConfig } from './observability-config.js';

export { LOG_LEVELS } from './observability-config.js';
export type { LogLevel } from './observability-config.js';

export const REDACTED = '[redacted]';
export const CIRCULAR = '[circular]';
export const TRUNCATED = '[truncated]';
export const UNREADABLE = '[unreadable]';
export const UNSUPPORTED = '[unsupported]';

/**
 * Header, credential, and token keys. Case-insensitive, so `apiKey`, `apikey`,
 * `x-api-key`, `Set-Cookie`, and `Authorization` all match.
 */
export const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key/i;

/**
 * Contact-identifier keys. Case-insensitive and substring-matched, so `email`,
 * `Email`, `user_email`, and `emailAddress` all match. Values are replaced
 * wholesale: an address is PII, never diagnostic.
 */
export const EMAIL_KEY_PATTERN = /email/i;

/**
 * Filename keys. Substring-matched, so `filename`, `fileName`, `file_name`,
 * `filepath`, and `file_path` all match. A filename can carry user content
 * (`my-divorce-papers.pdf`), so it is replaced wholesale. Bare `file`/`files`
 * stay under CONTENT_KEY_PATTERN; bare `path` is too generic to claim.
 */
export const FILE_KEY_PATTERN = /file[_-]?name|filepath|file[_-]?path/i;

/**
 * Whole-key content markers. Whole-key matching keeps `contentLength` or
 * `errorMessage` diagnostic while still dropping request/response payloads.
 */
export const CONTENT_KEY_PATTERN =
  /^(prompt|prompts|messages?|content|body|payload|upload|uploads|file|files|attachment|attachments)$/i;

const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 64;
const MAX_STRING_LENGTH = 1024;
const MAX_MESSAGE_LENGTH = 500;
const MAX_LINE_LENGTH = 16384;
const INVALID_DATE = '[invalid-date]';
const TRUNCATED_KEY = TRUNCATED;

const LEVEL_RANK: Record<LogLevel, number> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const RESERVED_FIELD_KEYS = new Set([
  'ts',
  'level',
  'service',
  'event',
  'logTruncated',
  'logLength',
  'logError',
]);

const UNSAFE_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const INVALID_EVENT = 'log.invalid_event';

export type LogFields = Readonly<Record<string, unknown>>;

export interface SanitizedError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

/**
 * Returns a JSON-safe copy of `value` with sensitive keys and content removed.
 * Safe to call on cyclic, deeply nested, proxied, or non-JSON values.
 */
export function redact(value: unknown): unknown {
  try {
    return redactValue(value, new WeakSet<object>(), 0);
  } catch {
    return UNREADABLE;
  }
}

/**
 * Flattens control characters, scrubs inline credentials, and truncates. The
 * result is safe to log but is not classified content: a caller must not put
 * prompt text in an error message in the first place.
 */
export function sanitizeErrorMessage(message: string): string {
  const flattened = flattenControlCharacters(message).trim();
  const scrubbed = flattened
    .replaceAll(/\b(Bearer|Basic|Digest)\s+[a-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replaceAll(
      /\b(password|passwd|secret|token|api[-_]?key)=([^&\s]+)/gi,
      '$1=[redacted]',
    )
    .replaceAll(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      '[redacted]',
    );

  return truncate(scrubbed, MAX_MESSAGE_LENGTH);
}

/** Error name, optional code, and sanitized message. Never includes a stack. */
export function safeError(error: unknown): SanitizedError {
  if (!(error instanceof Error)) {
    const message =
      typeof error === 'string' ? error : 'non-error value thrown';

    return { name: 'Error', message: sanitizeErrorMessage(message) };
  }

  const code = readErrorCode(error);
  const name = error.name.length > 0 ? truncate(error.name, 64) : 'Error';

  return {
    name,
    ...(code === undefined ? {} : { code }),
    message: sanitizeErrorMessage(error.message),
  };
}

export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

@Injectable()
export class StructuredLogger {
  private readonly service: string;
  private readonly threshold: LogLevel;
  private readonly write: (line: string) => void;
  private readonly now: () => number;

  constructor(@Inject(OBSERVABILITY_CONFIG) config: ObservabilityConfig) {
    this.service = config.service;
    this.threshold = config.level;
    this.write = config.write ?? writeToStdout;
    this.now = config.now ?? Date.now;
  }

  debug(event: string, fields?: LogFields): void {
    this.emit('debug', event, fields);
  }

  info(event: string, fields?: LogFields): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields?: LogFields): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields?: LogFields): void {
    this.emit('error', event, fields);
  }

  isEnabled(level: LogLevel): boolean {
    return isLevelEnabled(level, this.threshold);
  }

  private emit(level: LogLevel, event: unknown, fields?: LogFields): void {
    if (!this.isEnabled(level)) {
      return;
    }

    const base = {
      ts: new Date(this.now()).toISOString(),
      level,
      service: this.service,
      event: normalizeEvent(event),
    };

    let record: Record<string, unknown> = base;

    if (fields !== undefined) {
      try {
        const safe = redact(fields);
        const safeFields: Record<string, unknown> = {};

        if (isRecord(safe)) {
          for (const [key, value] of Object.entries(safe)) {
            if (RESERVED_FIELD_KEYS.has(key)) {
              continue;
            }

            safeFields[key] = value;
          }
        }

        record = { ...base, ...safeFields };
      } catch {
        // Redaction is expected never to throw; if it somehow does, keep the
        // envelope and report the failure instead of dropping the event.
        record = { ...base, logError: 'redaction_failed' };
      }
    }

    let line = safeStringify(record);

    if (line.length > MAX_LINE_LENGTH) {
      line = safeStringify({
        ...base,
        logTruncated: true,
        logLength: line.length,
      });
    }

    this.write(`${line}\n`);
  }
}

function writeToStdout(line: string): void {
  process.stdout.write(line);
}

function normalizeEvent(event: unknown): string {
  return typeof event === 'string' && EVENT_PATTERN.test(event)
    ? event
    : INVALID_EVENT;
}

function redactValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'string') {
    return truncate(value, MAX_STRING_LENGTH);
  }

  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === 'symbol' || typeof value === 'function') {
    return UNSUPPORTED;
  }

  const object = value as object;

  if (ancestors.has(object)) {
    return CIRCULAR;
  }

  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }

  ancestors.add(object);

  try {
    return redactContainer(object, ancestors, depth);
  } catch {
    return UNREADABLE;
  } finally {
    ancestors.delete(object);
  }
}

function redactContainer(
  object: object,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (object instanceof Date) {
    return redactDate(object);
  }

  if (object instanceof Error) {
    return safeError(object);
  }

  if (Array.isArray(object)) {
    return redactArray(object, ancestors, depth);
  }

  if (object instanceof Set) {
    return redactSet(object, ancestors, depth);
  }

  if (object instanceof Map) {
    return redactMap(object, ancestors, depth);
  }

  return redactObject(object as Record<string, unknown>, ancestors, depth);
}

function redactDate(value: Date): string {
  return Number.isNaN(value.getTime()) ? INVALID_DATE : value.toISOString();
}

function redactArray(
  value: readonly unknown[],
  ancestors: WeakSet<object>,
  depth: number,
): unknown[] {
  const limit = Math.min(value.length, MAX_ARRAY_ITEMS);
  const items: unknown[] = [];

  for (let index = 0; index < limit; index += 1) {
    items.push(redactValue(value[index], ancestors, depth + 1));
  }

  if (value.length > MAX_ARRAY_ITEMS) {
    items.push(TRUNCATED);
  }

  return items;
}

function redactSet(
  value: ReadonlySet<unknown>,
  ancestors: WeakSet<object>,
  depth: number,
): unknown[] {
  const items: unknown[] = [];

  for (const entry of value) {
    if (items.length >= MAX_ARRAY_ITEMS) {
      items.push(TRUNCATED);
      break;
    }

    items.push(redactValue(entry, ancestors, depth + 1));
  }

  return items;
}

function redactMap(
  value: ReadonlyMap<unknown, unknown>,
  ancestors: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  let count = 0;

  for (const [key, entry] of value) {
    if (count >= MAX_OBJECT_KEYS) {
      entries[TRUNCATED_KEY] = true;
      break;
    }

    entries[truncate(String(key), 64)] = redactValue(
      entry,
      ancestors,
      depth + 1,
    );
    count += 1;
  }

  return entries;
}

function redactObject(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const keys = Object.keys(value);
  const limit = Math.min(keys.length, MAX_OBJECT_KEYS);

  for (let index = 0; index < limit; index += 1) {
    const key = keys[index];

    if (key === undefined || UNSAFE_PROPERTY_KEYS.has(key)) {
      continue;
    }

    if (SENSITIVE_KEY_PATTERN.test(key) || CONTENT_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }

    if (EMAIL_KEY_PATTERN.test(key) || FILE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || descriptor.get !== undefined) {
      output[key] = UNREADABLE;
      continue;
    }

    output[key] = redactValue(descriptor.value, ancestors, depth + 1);
  }

  if (keys.length > limit) {
    output[TRUNCATED_KEY] = true;
  }

  return output;
}

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const value = (error as { code?: unknown }).code;

  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  return truncate(String(value), 64);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}${TRUNCATED}`;
}

/**
 * Collapses C0 controls and DEL to spaces so an exception message can never
 * forge a second log line or inject terminal escapes.
 */
function flattenControlCharacters(value: string): string {
  let output = '';

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    output += codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '{"level":"error","event":"log.serialize_failed"}';
  }
}
