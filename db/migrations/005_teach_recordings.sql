-- 005_teach_recordings: Teach Mode (agent K). Recordings posted by the Chrome extension
-- (extension/ → POST /api/teach/recordings), the LLM-normalized skill draft, and the saved skill.
-- Idempotent.

CREATE TABLE IF NOT EXISTS teach_recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recording   jsonb NOT NULL,                       -- lib/contracts Recording, as received
  status      text NOT NULL DEFAULT 'received'
              CHECK (status IN ('received', 'normalized', 'saved', 'failed')),
  normalized  jsonb,                                -- TaughtSkillDraft (lib/learn/normalize.ts), editable before save
  skill_id    uuid REFERENCES personal_skills(id) ON DELETE SET NULL,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teach_recordings_user_idx ON teach_recordings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS teach_recordings_skill_idx ON teach_recordings (skill_id);
