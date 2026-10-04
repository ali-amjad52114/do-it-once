-- 002_skill_embeddings: semantic skill retrieval (agent L1, lib/skills/retrieve.ts).
-- Idempotent. skill_triggers.embedding vector(1024) already exists (001_init).

CREATE EXTENSION IF NOT EXISTS vector;

-- Approximate nearest-neighbour index for cosine distance (`<=>`) over trigger phrase embeddings.
CREATE INDEX IF NOT EXISTS skill_triggers_embedding_hnsw
  ON skill_triggers USING hnsw (embedding vector_cosine_ops);

-- One synthetic "profile" phrase per skill (title + description) and its embedding.
-- Separate table so it never shows up as a user-visible trigger phrase, is not removed by the seed
-- script's trigger cleanup, and does not bloat `SELECT * FROM personal_skills`.
CREATE TABLE IF NOT EXISTS skill_profile_embeddings (
  skill_id    uuid PRIMARY KEY REFERENCES personal_skills(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phrase      text NOT NULL,
  embedding   vector(1024) NOT NULL,
  embed_model text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_profile_embeddings_user_idx ON skill_profile_embeddings (user_id);
CREATE INDEX IF NOT EXISTS skill_profile_embeddings_hnsw
  ON skill_profile_embeddings USING hnsw (embedding vector_cosine_ops);
