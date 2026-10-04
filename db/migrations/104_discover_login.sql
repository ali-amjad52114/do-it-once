-- Discovery login handoff: the user signs in in the interactive live view; Kernel saves it in a profile per site host.
-- No credentials are stored here: only the profile name and the login browser session.
ALTER TABLE discoveries ADD COLUMN IF NOT EXISTS login_session jsonb;

CREATE TABLE IF NOT EXISTS site_logins (
  user_id      uuid NOT NULL,
  host         text NOT NULL,
  profile_name text NOT NULL,
  signed_in_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, host)
);
