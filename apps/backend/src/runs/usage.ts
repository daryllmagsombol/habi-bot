/**
 * Usage normalization. The adapter is the only source of provider usage, and
 * absence is never zero:
 *
 *   known    complete, consistent numbers from the adapter
 *   partial  a defensible subset; missing fields stay null
 *   unknown  absent, inconsistent, or ambiguous dispatch; every count is null
 *
 * An adapter that reports `unknown` but also sends zeros is still unknown; the
 * zeros are discarded rather than rendered as "no charge".
 */
import type { UsageRecord } from '../adapters/harness-adapter.js';
import type { RunUsage } from './types.js';

export interface PersistedRunUsage extends RunUsage {
  raw: Readonly<Record<string, unknown>>;
}

const UNKNOWN_COUNTS = {
  grossPromptTokens: null,
  grossCompletionTokens: null,
  cachedPromptTokens: null,
  reasoningTokens: null,
  totalTokens: null,
} as const;

export function unknownUsage(): PersistedRunUsage {
  return {
    status: 'unknown',
    ...UNKNOWN_COUNTS,
    costStatus: 'unknown',
    raw: {},
  };
}

function toCount(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Maps one adapter record to persisted usage. Unknown dominates: no count from
 * an unknown record is trusted, so a UI can never show a fabricated zero.
 */
export function normalizeUsage(record: UsageRecord | null | undefined): PersistedRunUsage {
  if (record === null || record === undefined || record.usageStatus === 'unknown') {
    return unknownUsage();
  }

  const counts = {
    grossPromptTokens: toCount(record.grossPromptTokens),
    grossCompletionTokens: toCount(record.grossCompletionTokens),
    cachedPromptTokens: toCount(record.cachedPromptTokens),
    reasoningTokens: toCount(record.reasoningTokens),
    totalTokens: toCount(record.totalTokens),
  };

  const hasAnyCount = Object.values(counts).some((value) => value !== null);
  const complete =
    counts.grossPromptTokens !== null &&
    counts.grossCompletionTokens !== null &&
    counts.totalTokens !== null;

  let status: RunUsage['status'] = record.usageStatus;

  if (!hasAnyCount) {
    status = 'unknown';
  } else if (status === 'known' && !complete) {
    status = 'partial';
  }

  if (status === 'unknown') {
    return {
      ...unknownUsage(),
      raw: record.raw,
    };
  }

  return {
    status,
    ...counts,
    costStatus: record.costStatus === 'known' ? 'known' : 'unknown',
    raw: record.raw,
  };
}
