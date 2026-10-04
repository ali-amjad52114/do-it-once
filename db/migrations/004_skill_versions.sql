-- 004_skill_versions: history of a skill's step definitions (self-heal creates new versions)
-- plus pending heals per run (so an approval resumed in a fresh process still uses the healed path).
CREATE TABLE IF NOT EXISTS skill_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id    uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  reason      text NOT NULL DEFAULT 'seed' CHECK (reason IN ('seed', 'heal', 'teach', 'edit')),
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
CREATE INDEX IF NOT EXISTS skill_versions_skill_idx ON skill_versions (skill_id, version DESC);

CREATE TABLE IF NOT EXISTS skill_heals (
  run_id       uuid PRIMARY KEY REFERENCES skill_runs(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  base_version integer NOT NULL,
  steps        jsonb NOT NULL,
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Backfill: the current step list of every existing skill becomes its first recorded version.
INSERT INTO skill_versions (skill_id, version, reason, steps, note)
SELECT p.id, p.version, 'seed',
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'skillId', s.skill_id, 'sequence', s.sequence, 'intent', s.intent, 'actionType', s.action_type,
      'targetDescription', s.target_description, 'inputSource', s.input_source, 'expectedBefore', s.expected_before,
      'expectedAfter', s.expected_after, 'locatorHint', s.locator_hint, 'requiresApproval', s.requires_approval,
      'config', s.config) ORDER BY s.sequence)
    FROM skill_steps s WHERE s.skill_id = p.id), '[]'::jsonb),
  'Learned path'
FROM personal_skills p
ON CONFLICT (skill_id, version) DO NOTHING;
