/**
 * Pure mapping from reported provider usage to allowance units.
 *
 * Rules come from the accepted provider-access design §7:
 *
 *   - Units are gross prompt + gross completion. Cached prompt tokens and
 *     reasoning tokens are never added on top; they are subsets of the gross
 *     counts for the providers Habi supports.
 *   - `known` requires both gross counts and an internally consistent total.
 *   - `partial` charges the largest defensible reported total, never a
 *     favourable subset.
 *   - Anything absent, zero-only, or ambiguous is `unknown`, and unknown is
 *     never mapped to zero.
 *
 * Only counts arrive here. No prompt text, provider payload, or identity is
 * accepted, so a usage record cannot carry content into this layer.
 */
import { UsageLimitError } from './errors.js';
import type { SettleUsageInput } from './types.js';

export type UnknownUsageReason =
  | 'reported_unknown'
  | 'no_reliable_counts'
  | 'zero_is_not_evidence';

export type ResolvedCharge =
  | {
      readonly status: 'known';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | {
      readonly status: 'partial';
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | { readonly status: 'unknown'; readonly reason: UnknownUsageReason };

interface Counts {
  readonly prompt: number | null;
  readonly completion: number | null;
  readonly total: number | null;
  readonly cached: number | null;
  readonly reasoning: number | null;
}

interface Candidate {
  readonly value: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function toCount(value: number | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageLimitError('invalid_usage');
  }

  return value;
}

function readCounts(usage: SettleUsageInput): Counts {
  return {
    prompt: toCount(usage.grossPromptTokens),
    completion: toCount(usage.grossCompletionTokens),
    total: toCount(usage.totalTokens),
    cached: toCount(usage.cachedPromptTokens),
    reasoning: toCount(usage.reasoningTokens),
  };
}

/** Sum guard: a reported pair must still be a safe integer aggregate. */
function sumCounts(left: number, right: number): number {
  const sum = left + right;

  if (!Number.isSafeInteger(sum)) {
    throw new UsageLimitError('invalid_usage');
  }

  return sum;
}

/**
 * A reported description is internally consistent when the aggregate matches
 * the components and the subset counters do not exceed their parent counts.
 * Inconsistency downgrades the record to `partial`; it is never resolved in the
 * user's favour.
 */
function isConsistent(counts: Counts): boolean {
  const { prompt, completion, total, cached, reasoning } = counts;

  if (prompt === null || completion === null) {
    return false;
  }

  const sum = sumCounts(prompt, completion);

  return (
    (total === null || total === sum) &&
    (cached === null || cached <= prompt) &&
    (reasoning === null || reasoning <= completion)
  );
}

/**
 * Largest defensible total. Attributed candidates are preferred over an
 * aggregate-only total on ties, so the input/output split is kept whenever the
 * provider supplied both counts. An aggregate total that wins is recorded
 * against input; only the sum is enforced.
 */
function largestDefensible(counts: Counts): Candidate | null {
  const candidates: Candidate[] = [];

  if (counts.prompt !== null && counts.completion !== null) {
    candidates.push({
      value: sumCounts(counts.prompt, counts.completion),
      inputTokens: counts.prompt,
      outputTokens: counts.completion,
    });
  }

  if (counts.prompt !== null) {
    candidates.push({
      value: counts.prompt,
      inputTokens: counts.prompt,
      outputTokens: 0,
    });
  }

  if (counts.completion !== null) {
    candidates.push({
      value: counts.completion,
      inputTokens: 0,
      outputTokens: counts.completion,
    });
  }

  if (counts.total !== null) {
    candidates.push({
      value: counts.total,
      inputTokens: counts.total,
      outputTokens: 0,
    });
  }

  let best: Candidate | null = null;

  for (const candidate of candidates) {
    if (best === null || candidate.value > best.value) {
      best = candidate;
    }
  }

  return best;
}

export function resolveUsageCharge(
  usage: SettleUsageInput | null | undefined,
): ResolvedCharge {
  if (usage === null || usage === undefined) {
    return { status: 'unknown', reason: 'no_reliable_counts' };
  }

  if (usage.status !== 'known' && usage.status !== 'partial' && usage.status !== 'unknown') {
    throw new UsageLimitError('invalid_usage');
  }

  if (usage.status === 'unknown') {
    return { status: 'unknown', reason: 'reported_unknown' };
  }

  const counts = readCounts(usage);

  if (usage.status === 'known' && isConsistent(counts)) {
    // `isConsistent` guarantees non-null prompt and completion.
    const inputTokens = counts.prompt ?? 0;
    const outputTokens = counts.completion ?? 0;

    return {
      status: 'known',
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    };
  }

  const best = largestDefensible(counts);

  if (best === null) {
    return { status: 'unknown', reason: 'no_reliable_counts' };
  }

  if (best.value === 0) {
    // A zero-only report from a request that reached a provider is not evidence
    // that nothing was billed, so it cannot settle anything.
    return { status: 'unknown', reason: 'zero_is_not_evidence' };
  }

  return {
    status: 'partial',
    inputTokens: best.inputTokens,
    outputTokens: best.outputTokens,
    totalTokens: best.value,
  };
}
