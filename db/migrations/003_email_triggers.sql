-- 003_email_triggers: inbound email → incoming_triggers (agent S4).
-- external_id: provider message id (AgentMail message_id) used for idempotent ingest (webhook
-- retries, webhook + sync racing). NULL for seed/manual triggers, so the unique index allows many.
ALTER TABLE incoming_triggers ADD COLUMN IF NOT EXISTS external_id  text;
ALTER TABLE incoming_triggers ADD COLUMN IF NOT EXISTS from_address text;
ALTER TABLE incoming_triggers ADD COLUMN IF NOT EXISTS received_at  timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS incoming_triggers_external_id_key
  ON incoming_triggers (external_id) WHERE external_id IS NOT NULL;
