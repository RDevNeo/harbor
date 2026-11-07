-- The account vault's key (src/vault.js): one random 256-bit key per account, which the account's
-- PCs encrypt the vault's rows with. Kept sealed (AES-256-GCM) with the Worker secret VAULT_SECRET;
-- handed only to the account's own signed-in PCs. `epoch`: the vault it's for (its `meta` row).
CREATE TABLE vault_keys (
  user_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  k TEXT NOT NULL,
  at INTEGER NOT NULL
);
