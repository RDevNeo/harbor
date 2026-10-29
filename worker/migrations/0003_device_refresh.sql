-- Phones that signed in with Android's own Google account picker (no Clerk OAuth tokens): a
-- secret per device renews its Harbor token. Additive.
CREATE TABLE IF NOT EXISTS device_refresh (
  fp TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS device_refresh_user ON device_refresh (user_id);
