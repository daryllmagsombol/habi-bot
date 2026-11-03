-- H-002 §13: tenancy root and Bot linkage required by the Conversation aggregate.
--
-- This migration creates only the User and Bot columns the conversation
-- aggregate needs to enforce ownership relationally. It is not an auth schema
-- (#8/#17) and not the Bot profile schema (#24). Later migrations extend these
-- tables; they must not replace the ownership constraints defined here.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);

CREATE INDEX users_status_idx ON users (status);

CREATE TABLE bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT bots_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT bots_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  -- Supports the composite foreign key that keeps a conversation's Bot in the
  -- same ownership chain as the conversation itself.
  CONSTRAINT bots_id_owner_key UNIQUE (id, owner_user_id)
);

CREATE INDEX bots_owner_status_idx ON bots (owner_user_id, status);
CREATE INDEX bots_owner_updated_idx ON bots (owner_user_id, updated_at DESC);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  -- Server-owned monotonic message order allocator (H-002 §9.1).
  last_message_seq bigint NOT NULL DEFAULT 0
    CHECK (last_message_seq >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT conversations_owner_fk
    FOREIGN KEY (owner_user_id) REFERENCES users (id),
  -- Bot ownership must agree with conversation ownership at write time.
  CONSTRAINT conversations_bot_owner_fk
    FOREIGN KEY (bot_id, owner_user_id) REFERENCES bots (id, owner_user_id),
  CONSTRAINT conversations_deleted_at_matches_status
    CHECK ((status = 'deleted') = (deleted_at IS NOT NULL)),
  CONSTRAINT conversations_title_nonempty
    CHECK (length(btrim(title)) > 0),
  -- Lets messages/runs repeat owner_user_id and still prove parent ownership
  -- with a composite foreign key rather than a join-only guess.
  CONSTRAINT conversations_id_owner_key UNIQUE (id, owner_user_id)
);

-- Owner-scoped conversation listing, including stable keyset pagination.
CREATE INDEX conversations_owner_updated_idx
  ON conversations (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX conversations_owner_status_idx
  ON conversations (owner_user_id, status);
CREATE INDEX conversations_bot_idx
  ON conversations (bot_id);
