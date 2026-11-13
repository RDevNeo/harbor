-- The workspace cloud (src/cloud.js): each PC's chats (metadata and transcripts) and projects, encrypted by the
-- PCs with their workspace's key, so a workspace's members read them with that PC off. The service sees opaque
-- ids (keyed hashes, prefixed m: chat, k: transcript chunk, p: project) and ciphertext.
-- `by`: the fingerprint of the PC that wrote the row (only it rewrites it). `seq`: when the service last wrote it
-- (ms, rising per workspace): what a PC asks for since.
CREATE TABLE cloud (
  ws TEXT NOT NULL,
  id TEXT NOT NULL,
  v TEXT,
  at INTEGER NOT NULL,
  by TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (ws, id)
);
CREATE INDEX cloud_seq ON cloud (ws, seq);
-- One random 256-bit key per workspace, sealed (AES-256-GCM) with the Worker secret VAULT_SECRET, handed to the
-- workspace's members' signed-in PCs. `epoch` changes when the key does (the PCs start their copy over).
CREATE TABLE cloud_keys (
  ws TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  k TEXT NOT NULL,
  at INTEGER NOT NULL
);
