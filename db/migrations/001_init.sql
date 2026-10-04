-- 001_init: Do It Once core schema (see docs/CONTRACTS.md "Database").
-- Idempotent: every object uses IF NOT EXISTS. Does not touch `hello` or `mastra_*`.

CREATE EXTENSION IF NOT EXISTS vector;

-- The shared dev DB already had an unrelated, EMPTY `users` table from an older project
-- (integer id + clerk_id). Our `users` needs a uuid id, so that legacy table is renamed
-- (never dropped) to `legacy_users`. Refuses to proceed if it holds any rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id' AND data_type = 'integer'
  ) THEN
    IF EXISTS (SELECT 1 FROM public.users LIMIT 1) THEN
      RAISE EXCEPTION 'public.users exists with an integer id and contains rows; refusing to rename it';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'legacy_users') THEN
      RAISE EXCEPTION 'public.users has an integer id but legacy_users already exists';
    END IF;
    ALTER TABLE public.users RENAME TO legacy_users;
  END IF;
END
$$;

-- ── Users
CREATE TABLE IF NOT EXISTS users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Skills
CREATE TABLE IF NOT EXISTS personal_skills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  version         integer NOT NULL DEFAULT 1,
  icon            text NOT NULL DEFAULT 'skill',
  target_domains  text[] NOT NULL DEFAULT '{}',
  start_url       text,
  verification    jsonb NOT NULL DEFAULT '{}'::jsonb,
  value_per_year  double precision,
  run_count       integer NOT NULL DEFAULT 0,
  success_count   integer NOT NULL DEFAULT 0,
  confidence      double precision NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_skills_user_idx ON personal_skills (user_id);

CREATE TABLE IF NOT EXISTS skill_triggers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phrase      text NOT NULL,
  embedding   vector(1024),          -- filled in S3
  embed_model text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, phrase)
);
CREATE INDEX IF NOT EXISTS skill_triggers_skill_idx ON skill_triggers (skill_id);
CREATE INDEX IF NOT EXISTS skill_triggers_user_idx ON skill_triggers (user_id);

CREATE TABLE IF NOT EXISTS skill_steps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id           uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  sequence           integer NOT NULL CHECK (sequence >= 1),
  intent             text NOT NULL,
  action_type        text NOT NULL CHECK (action_type IN ('navigate', 'click', 'type', 'select', 'extract', 'wait', 'screenshot')),
  target_description text,
  input_source       text,
  expected_before    text,
  expected_after     text,
  locator_hint       text,
  requires_approval  boolean NOT NULL DEFAULT false,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, sequence)
);
CREATE INDEX IF NOT EXISTS skill_steps_skill_idx ON skill_steps (skill_id);

CREATE TABLE IF NOT EXISTS skill_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, key)
);
CREATE INDEX IF NOT EXISTS skill_preferences_skill_idx ON skill_preferences (skill_id);

-- ── Incoming triggers (Today items)
CREATE TABLE IF NOT EXISTS incoming_triggers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('email', 'manual', 'seed')),
  subject          text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  matched_skill_id uuid REFERENCES personal_skills(id) ON DELETE SET NULL,
  state            text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'done', 'dismissed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incoming_triggers_user_state_idx ON incoming_triggers (user_id, state);
CREATE INDEX IF NOT EXISTS incoming_triggers_skill_idx ON incoming_triggers (matched_skill_id);

-- ── Runs
CREATE TABLE IF NOT EXISTS skill_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id           uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_id         uuid REFERENCES incoming_triggers(id) ON DELETE SET NULL,
  state              text NOT NULL DEFAULT 'queued'
                     CHECK (state IN ('queued', 'running', 'waiting_approval', 'resumed', 'verifying', 'succeeded', 'failed', 'stopped')),
  current_step       integer NOT NULL DEFAULT 0,
  browser_session_id text,
  live_view_url      text,
  error              text,
  result             jsonb,
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skill_runs_skill_idx ON skill_runs (skill_id, started_at DESC);
CREATE INDEX IF NOT EXISTS skill_runs_user_idx ON skill_runs (user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS skill_runs_trigger_idx ON skill_runs (trigger_id, started_at DESC);

CREATE TABLE IF NOT EXISTS execution_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
  sequence    integer NOT NULL CHECK (sequence >= 1),
  type        text NOT NULL,
  message     text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT execution_events_run_sequence_key UNIQUE (run_id, sequence)
);

CREATE TABLE IF NOT EXISTS approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
  step_sequence integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  title         text NOT NULL,
  description   text NOT NULL DEFAULT '',
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX IF NOT EXISTS approvals_run_idx ON approvals (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
  type           text NOT NULL CHECK (type IN ('screenshot', 'pdf', 'label', 'file')),
  mime_type      text NOT NULL,
  location       text NOT NULL,
  content_base64 text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id, created_at);
