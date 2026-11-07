-- The account vault (src/vault.js): rows the account's PCs encrypt end to end. The service sees
-- only opaque ids (hashes, or key-management ids like `key:<fp>`) and ciphertext.
-- `seq`: when the service last wrote the row (ms, rising per account): what a PC asks for since.
CREATE TABLE vault (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  v TEXT,
  at INTEGER NOT NULL,
  by TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX vault_seq ON vault (user_id, seq);
