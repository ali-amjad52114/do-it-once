-- A3 AI judge: one row per judge call on a verified run (display only; skill_runs.state is never changed).
CREATE TABLE IF NOT EXISTS judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES skill_runs(id) ON DELETE CASCADE,
  model text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('pass', 'fail', 'unsure')),
  confidence real NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS judgments_run_id_idx ON judgments (run_id, created_at DESC);
