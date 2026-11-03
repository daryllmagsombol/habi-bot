-- H-029 (#29): owner-scoped full-text search over conversation messages.
--
-- Additive and forward-only. Message semantics, the append path, and every
-- existing constraint are unchanged: this migration only adds a derived search
-- column and its index, so no writer has to maintain search state.
--
-- `search_vector` is a stored generated column. Adding it makes PostgreSQL
-- compute it for every existing row (the backfill) and for every later
-- insert/update, without a trigger, a second write, or an application change.
-- The `english` configuration is fixed explicitly so the expression is
-- immutable and therefore legal in a generated column. Content is indexed
-- verbatim; no secret, prompt, or field other than `messages.content` enters
-- the vector.
--
-- A plain GIN index is used instead of a partial one: tombstoned and deleted
-- rows stay indexed for retention/cleanup work, while every search statement
-- carries the owner and lifecycle predicates itself. The owner/conversation
-- filters continue to use `messages_owner_conversation_idx`.
--
-- Not indexed by this migration: conversation titles, Bot names/instructions,
-- and attachment/artifact bytes (message search is the only scope for #29).

ALTER TABLE messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, content)) STORED;

CREATE INDEX messages_search_vector_idx
  ON messages USING GIN (search_vector);
