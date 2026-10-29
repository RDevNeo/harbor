CREATE TABLE accounts (
  user_id TEXT PRIMARY KEY,
  personal_ws TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE pcs (
  fp TEXT PRIMARY KEY,
  pid TEXT NOT NULL DEFAULT '',
  ws TEXT NOT NULL,
  name TEXT NOT NULL,
  addrs TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL,
  owner_name TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL
);
CREATE INDEX pcs_ws ON pcs (ws);

CREATE TABLE devices (
  fp TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  seen INTEGER NOT NULL
);
CREATE INDEX devices_user ON devices (user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  ws TEXT NOT NULL,
  email TEXT NOT NULL,
  inviter TEXT NOT NULL,
  clerk_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  at INTEGER NOT NULL
);
CREATE INDEX invites_email ON invites (email, status);
CREATE INDEX invites_ws ON invites (ws, status);
