-- Stoop — sessions and the app's own short session store.
--
-- The app keeps its own session after the OIDC code exchange. The browser holds
-- an opaque random token; only its SHA-256 hash is stored, so a database dump
-- does not hand anyone a live session.

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text NOT NULL UNIQUE,
  auth_user_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- Items get an updated_at so the shell can order by "last touched".
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
