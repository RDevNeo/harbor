-- Peers by membership (/v1/directory `peers`): the PCs whose owner shares a workspace with this PC's owner.
CREATE INDEX IF NOT EXISTS pcs_owner ON pcs (owner);
