-- Names shown with a pending invitation (Accept/Decline in Harbor). Additive: existing rows keep
-- empty names and the Worker looks them up in Clerk.
ALTER TABLE invites ADD COLUMN ws_name TEXT NOT NULL DEFAULT '';
ALTER TABLE invites ADD COLUMN inviter_name TEXT NOT NULL DEFAULT '';
