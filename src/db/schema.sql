-- CoachOS Database Schema

CREATE TABLE IF NOT EXISTS coaches (
  id          SERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  email       TEXT        NOT NULL UNIQUE,
  plan        TEXT        NOT NULL DEFAULT 'free',
  subdomain   TEXT        UNIQUE,
  branding    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'client',
  name          TEXT        NOT NULL,
  deletable     BOOLEAN     NOT NULL DEFAULT TRUE,
  coach_id      INTEGER     REFERENCES coaches(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER     NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  program       TEXT,
  phase         TEXT,
  progress      JSONB       NOT NULL DEFAULT '{}',
  status        TEXT        NOT NULL DEFAULT 'active',
  start_weight  NUMERIC(6,2),
  goal          TEXT,
  flagged       BOOLEAN     NOT NULL DEFAULT FALSE,
  flag_reason   TEXT,
  flag_type     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS queue_items (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER     NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  agent         TEXT        NOT NULL,
  client_name   TEXT        NOT NULL,
  preview       TEXT,
  draft         TEXT,
  original_draft TEXT,
  status        TEXT        NOT NULL DEFAULT 'pending',
  auto_send     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_custom_fields (
  id                  SERIAL PRIMARY KEY,
  coach_id            INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  client_id           TEXT    NOT NULL,
  program_start_date  DATE,
  program_expiration  DATE,
  UNIQUE (coach_id, client_id)
);

CREATE TABLE IF NOT EXISTS agent_settings (
  id          SERIAL PRIMARY KEY,
  coach_id    INTEGER     NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  agent       TEXT        NOT NULL,
  autonomous  BOOLEAN     NOT NULL DEFAULT FALSE,
  threshold   INTEGER     NOT NULL DEFAULT 80,
  scheduled   BOOLEAN     NOT NULL DEFAULT FALSE,
  from_time   TIME,
  to_time     TIME,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (coach_id, agent)
);

CREATE TABLE IF NOT EXISTS agent_requests (
  id           SERIAL PRIMARY KEY,
  coach_id     INTEGER     NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  agent        TEXT        NOT NULL,
  request_text TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending',
  admin_note   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS style_edits (
  id          SERIAL PRIMARY KEY,
  coach_id    INTEGER     NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  agent_type  TEXT        NOT NULL,
  original    TEXT        NOT NULL,
  edited      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
