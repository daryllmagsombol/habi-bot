-- H-023 (#23): daily token allowance and reservation accounting.
--
-- Scope of this migration: shared-key allowance accounting only. It adds no
-- HTTP route, no provider call, no queue, no admin stop switch, and no global
-- budget. The accepted provider-access design
-- (docs/superpowers/specs/2026-10-28-provider-access-and-daily-allowance-design.md)
-- sets the rules implemented here:
--
--   * one bucket per Habi user per Asia/Manila calendar day
--     (100,000 input + output tokens, reset at 00:00 Asia/Manila);
--   * an atomic reservation before dispatch, so concurrent requests cannot
--     both observe the same remaining allowance;
--   * `known` / `partial` / `unknown` usage where unknown is never zero and
--     blocks further shared-key reservations until an owner reconciliation;
--   * a durable, append-only audit row for every manual resolution.
--
-- `day_bucket` is a `date`, not a timestamp: the calendar day is computed once
-- by the service in Asia/Manila (UTC+8, no daylight saving) and stored as the
-- plain date. Storing a timestamp here would re-open the timezone question at
-- every read. The service derives the day with Intl.DateTimeFormat so no
-- timezone database, extension, or dependency is needed in PostgreSQL.
--
-- Usage semantics: `input_tokens` and `output_tokens` are committed counts,
-- `reserved_tokens` is the sum of in-flight upper bounds (including `unknown`
-- holds that must not be treated as zero). Committed usage is never truncated
-- to the allowance: an overrun is recorded honestly and refuses the next
-- reservation instead of hiding a charge.

CREATE TABLE usage_buckets (
  owner_user_id uuid NOT NULL,
  day_bucket date NOT NULL,
  -- Committed gross input + output tokens for this owner and day.
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  -- Outstanding upper bounds that still count while a Run is in flight, plus
  -- unresolved `unknown` holds until the owner reconciles them.
  reserved_tokens bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'known'
    CHECK (state IN ('known', 'partial', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_buckets_pkey PRIMARY KEY (owner_user_id, day_bucket),
  CONSTRAINT usage_buckets_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT usage_buckets_counters_nonnegative
    CHECK (
      input_tokens >= 0
      AND output_tokens >= 0
      AND reserved_tokens >= 0
    ),
  -- A `partial` bucket must have recorded some committed usage, and an
  -- `unknown` bucket keeps its unresolved reservation held (the invariant the
  -- service relies on so an unknown charge is never silently released to zero).
  CONSTRAINT usage_buckets_state_matches_values
    CHECK (
      (state <> 'partial' OR input_tokens + output_tokens > 0)
      AND (state <> 'unknown' OR reserved_tokens > 0)
    )
);

-- Reconciliation lookups and future operator reporting are per-day. The
-- primary key already serves owner-first reads.
CREATE INDEX usage_buckets_day_state_idx
  ON usage_buckets (day_bucket, state);

CREATE TABLE usage_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  -- Habi Run id chosen by the run controller. It is intentionally not a foreign
  -- key: admission reserves before dispatch and the reservation must exist even
  -- if the Run row is written afterwards. A "unique per run" key below makes a
  -- duplicate submit reuse the first reservation instead of double-counting.
  run_id uuid NOT NULL,
  day_bucket date NOT NULL,
  -- Server-computed upper bound for this request. Always positive so a
  -- reservation can never be a no-op by accident.
  estimated_tokens bigint NOT NULL,
  -- Tokens actually committed to the bucket for this Run. Zero while reserved
  -- or released; the final count when settled; the held estimate when unknown.
  charged_tokens bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'settled', 'released', 'unknown')),
  -- Reported classification for a terminal reservation. Null before it settles.
  usage_status text
    CHECK (usage_status IS NULL OR usage_status IN ('known', 'partial', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  released_at timestamptz,
  -- Manual resolution of an `unknown` reservation (H-023 reconcile path).
  reconciled_at timestamptz,
  reconciled_by uuid,
  reconcile_note text,
  CONSTRAINT usage_reservations_bucket_fk
    FOREIGN KEY (owner_user_id, day_bucket)
    REFERENCES usage_buckets (owner_user_id, day_bucket),
  CONSTRAINT usage_reservations_owner_run_key UNIQUE (owner_user_id, run_id),
  CONSTRAINT usage_reservations_estimated_tokens_positive
    CHECK (estimated_tokens > 0),
  -- Settled usage may legitimately exceed the estimate: the estimate is an
  -- admission bound, not a provider guarantee. An overrun is recorded as-is.
  CONSTRAINT usage_reservations_charged_tokens_nonnegative
    CHECK (charged_tokens >= 0),
  -- State, timestamps, and counts must agree. A reserved or released row holds
  -- no charge; a settled row carries its committed count; an unknown row keeps
  -- its full estimate held and is only resolvable by an owner reconciliation.
  CONSTRAINT usage_reservations_state_matches_values
    CHECK (
      (
        state = 'reserved'
        AND charged_tokens = 0
        AND usage_status IS NULL
        AND settled_at IS NULL
        AND released_at IS NULL
      )
      OR (
        state = 'released'
        AND charged_tokens = 0
        AND usage_status IS NULL
        AND settled_at IS NULL
        AND released_at IS NOT NULL
      )
      OR (
        state = 'settled'
        AND usage_status IN ('known', 'partial')
        AND settled_at IS NOT NULL
        AND released_at IS NULL
      )
      OR (
        state = 'unknown'
        AND charged_tokens = estimated_tokens
        AND usage_status = 'unknown'
        AND settled_at IS NOT NULL
        AND released_at IS NULL
      )
    ),
  -- Reconciliation metadata is all-or-nothing and only applies to an unknown
  -- reservation, which is the only state the reconcile path accepts.
  CONSTRAINT usage_reservations_reconciliation_shape
    CHECK (
      (reconciled_at IS NULL) = (reconciled_by IS NULL)
      AND (
        reconciled_at IS NULL
        OR (
          state = 'unknown'
          AND reconciled_by = owner_user_id
          AND reconcile_note IS NOT NULL
          AND char_length(btrim(reconcile_note)) BETWEEN 1 AND 500
        )
      )
    )
);

-- The reconcile path scans one owner/day for held unknown reservations.
CREATE INDEX usage_reservations_owner_day_state_idx
  ON usage_reservations (owner_user_id, day_bucket, state);

-- Append-only record of owner-triggered allowance adjustments. The service only
-- inserts here; there is no update or delete path. `tokens_delta` is the signed
-- change applied to committed usage, so a resolved zero is explicit rather than
-- an absence.
CREATE TABLE usage_limit_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  day_bucket date NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL
    CHECK (action IN ('reconcile')),
  tokens_delta bigint NOT NULL,
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_limit_audit_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT usage_limit_audit_actor_fk
    FOREIGN KEY (actor_user_id) REFERENCES users (id),
  CONSTRAINT usage_limit_audit_note_length
    CHECK (char_length(btrim(note)) BETWEEN 1 AND 500)
);

CREATE INDEX usage_limit_audit_owner_day_idx
  ON usage_limit_audit (owner_user_id, day_bucket, created_at);
