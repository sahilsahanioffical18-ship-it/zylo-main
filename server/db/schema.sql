CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  admission TEXT NOT NULL DEFAULT 'auto' CHECK (admission IN ('auto','manual')),
  screen_share_policy TEXT NOT NULL DEFAULT 'anyone' CHECK (screen_share_policy IN ('host_only','anyone')),
  max_participants INT NOT NULL DEFAULT 20 CHECK (max_participants BETWEEN 2 AND 20),
  mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard','translator')),
  ai_enabled BOOLEAN NOT NULL DEFAULT true,
  ai_nudges BOOLEAN NOT NULL DEFAULT false,
  scheduled_for TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- There is no migration system: server.js runs this whole file at every boot
-- (and test/helpers.js's setupTestDb runs it before every test file), so a
-- database created before `mode`, `ai_enabled` or `ai_nudges` existed is upgraded here with an idempotent
-- ALTER rather than a separate migration step.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'standard' CHECK (mode IN ('standard','translator'));
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ai_nudges BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS meeting_invites (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (meeting_id, email)
);
CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('host','participant')),
  first_joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (meeting_id, user_id)
);
CREATE INDEX IF NOT EXISTS meetings_host_idx ON meetings (host_id);
CREATE INDEX IF NOT EXISTS invites_email_idx ON meeting_invites (email);
CREATE INDEX IF NOT EXISTS participants_user_idx ON meeting_participants (user_id);
