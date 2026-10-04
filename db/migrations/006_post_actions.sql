-- 006_post_actions: API/workspace actions after a verified success (agent R, Wave B).
-- JSON array of PostAction (lib/contracts.ts): save_download -> Fly Sprite workspace, calendar_event -> Executor (.ics fallback).
ALTER TABLE personal_skills ADD COLUMN IF NOT EXISTS post_actions jsonb NOT NULL DEFAULT '[]'::jsonb;
