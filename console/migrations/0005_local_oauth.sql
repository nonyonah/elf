-- Pending browser installations only. Credentials are sealed and short-lived.
CREATE TABLE local_oauth (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('slack', 'figma')),
  challenge TEXT NOT NULL,
  browserHash TEXT NOT NULL,
  localState TEXT NOT NULL,
  returnUri TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'exchanging', 'ready')),
  grantHash TEXT UNIQUE,
  ciphertext TEXT,
  iv TEXT
);
CREATE INDEX local_oauth_expiry ON local_oauth(expiresAt);
