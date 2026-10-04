-- A4 Discovery race: a new goal explored by up to 3 parallel Kernel agents; the best becomes a draft skill.
CREATE TABLE IF NOT EXISTS discoveries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL,
  goal              text NOT NULL,
  start_url         text NOT NULL,
  state             text NOT NULL DEFAULT 'running',
  winner_attempt_id uuid,
  draft_skill_id    uuid,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discoveries_user_idx ON discoveries (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS discovery_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovery_id  uuid NOT NULL REFERENCES discoveries(id) ON DELETE CASCADE,
  lane          int NOT NULL,
  strategy      text NOT NULL,
  state         text NOT NULL DEFAULT 'running',
  live_view_url text,
  steps         int NOT NULL DEFAULT 0,
  actions       jsonb NOT NULL DEFAULT '[]'::jsonb,
  judgment      jsonb,
  recording_id  uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discovery_attempts_discovery_idx ON discovery_attempts (discovery_id, lane);
