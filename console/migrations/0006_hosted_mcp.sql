CREATE TABLE hosted_connections (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, fileKey TEXT NOT NULL,
 fileName TEXT, codeHash TEXT UNIQUE, codeExpires INTEGER,
 sessionHash TEXT UNIQUE, sessionExpires INTEGER, generation TEXT,
 approvedGeneration TEXT, heartbeat INTEGER, snapshot TEXT, mcpSeenAt INTEGER, createdAt INTEGER NOT NULL
);
CREATE INDEX hosted_connections_owner ON hosted_connections(owner);
CREATE TABLE hosted_plans (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, connectionId TEXT NOT NULL,
 generation TEXT NOT NULL, hash TEXT NOT NULL, operations TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'review', expires INTEGER NOT NULL,
 sourceHash TEXT, snapshot TEXT NOT NULL, createdAt INTEGER NOT NULL
);
CREATE TABLE hosted_operations (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, connectionId TEXT NOT NULL,
 generation TEXT NOT NULL, planId TEXT, ordinal INTEGER NOT NULL DEFAULT 0,
 method TEXT NOT NULL, params TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 result TEXT, createdAt INTEGER NOT NULL, startedAt INTEGER, expires INTEGER NOT NULL
);
CREATE INDEX hosted_operations_queue ON hosted_operations(connectionId, state, createdAt, ordinal);
CREATE TABLE hosted_sources (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, markdown TEXT NOT NULL,
 hash TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE TABLE hosted_consents (
 handleHash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL
);
