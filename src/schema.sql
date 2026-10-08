-- Esquema do banco. Roda automaticamente na inicialização (idempotente).

CREATE TABLE IF NOT EXISTS teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  supervisor_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  cargo         text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'colaborador' CHECK (role IN ('colaborador','supervisor','admin')),
  team_id       uuid REFERENCES teams(id) ON DELETE SET NULL,
  password_hash text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_supervisor_fk') THEN
    ALTER TABLE teams ADD CONSTRAINT teams_supervisor_fk FOREIGN KEY (supervisor_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- Links de convite e de redefinição de senha (uso único).
CREATE TABLE IF NOT EXISTS tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    text NOT NULL CHECK (purpose IN ('convite','senha')),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dados de cada pessoa: metas/ideias (goals), importações do Trello (boards) e configurações (settings).
CREATE TABLE IF NOT EXISTS docs (
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coll       text NOT NULL CHECK (coll IN ('goals','boards','settings')),
  doc_id     text NOT NULL,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, coll, doc_id)
);

CREATE TABLE IF NOT EXISTS photos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime       text NOT NULL,
  size       integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS photos_owner_idx ON photos(owner_id);
