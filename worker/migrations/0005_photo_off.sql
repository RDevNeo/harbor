-- People who removed their photo in Harbor: Clerk would otherwise show their Google one again.
CREATE TABLE IF NOT EXISTS photo_off (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
