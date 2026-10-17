-- elf-console schema 1.
-- Workspace-scoped data for the hosted side of elf; all timestamps are ISO 8601 UTC text.
-- Auth is hosted Clerk: no auth tables here — members.userId holds the Clerk user id (`user_…`).

-- Tenant root. One workspace per user in schema 1 (created on first sign-in).
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

-- user ↔ workspace. A UNIQUE index on userId enforces "one workspace per user" (schema 1).
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id),
  role TEXT NOT NULL DEFAULT 'owner',
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX members_user_unique ON members(userId);
CREATE INDEX members_workspace ON members(workspaceId);

-- One project = one codebase + one Figma file.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE UNIQUE INDEX projects_slug_unique ON projects(workspaceId, slug);
CREATE INDEX projects_workspace ON projects(workspaceId);

-- Outbound credentials (figma | slack), AES-GCM encrypted with a random IV per value.
-- The API never returns encryptedSecret/iv — write-only.
CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN ('figma', 'slack')),
  encryptedSecret TEXT,
  iv TEXT,
  meta TEXT,
  status TEXT NOT NULL DEFAULT 'unconfigured',
  statusMessage TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE UNIQUE INDEX connections_project_type_unique ON connections(projectId, type);

-- The Figma file binding + light polling state (Files endpoint only, never Variables).
CREATE TABLE figma_sources (
  projectId TEXT PRIMARY KEY REFERENCES projects(id),
  fileKey TEXT NOT NULL,
  fileName TEXT,
  lastVersion TEXT,
  lastModifiedAt TEXT,
  lastPolledAt TEXT
);

-- Access tokens: 32 random bytes shown once; only the SHA-256 hash + last 4 stored.
CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('push', 'plugin')),
  hash TEXT NOT NULL,
  last4 TEXT NOT NULL,
  label TEXT,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt TEXT
);
CREATE UNIQUE INDEX tokens_hash_unique ON tokens(hash);
CREATE INDEX tokens_project ON tokens(projectId);

-- Ingested payloads (POST /ingest/code and /ingest/figma), deduped by contentHash.
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('code', 'figma')),
  source TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  payload TEXT NOT NULL,
  gitBranch TEXT,
  gitCommit TEXT,
  receivedAt TEXT NOT NULL
);
CREATE INDEX snapshots_project_kind ON snapshots(projectId, kind, receivedAt);
CREATE INDEX snapshots_project_hash ON snapshots(projectId, contentHash);

-- One row per computed diff (elf core, client-agnostic).
CREATE TABLE drift_runs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  state TEXT NOT NULL CHECK (state IN ('ok', 'drift', 'stale', 'unknown')),
  counts TEXT,
  triggeredBy TEXT NOT NULL,
  error TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX drift_runs_project ON drift_runs(projectId, createdAt);

-- Remote config entries handed back by GET /projects/me/config.
CREATE TABLE deprecations (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('token', 'component')),
  reason TEXT,
  since TEXT,
  removeBy TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX deprecations_project ON deprecations(projectId);

-- Slack behavior per project; absence means the default (mode = 'change', overdueAlways = 1).
CREATE TABLE notification_rules (
  projectId TEXT PRIMARY KEY REFERENCES projects(id),
  mode TEXT NOT NULL DEFAULT 'change' CHECK (mode IN ('change', 'always', 'never')),
  overdueAlways INTEGER NOT NULL DEFAULT 1
);

-- Who did what. Secrets never land here — identifiers and actions only.
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL REFERENCES workspaces(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX audit_log_workspace ON audit_log(workspaceId, createdAt);

-- Deferred work (drift runs, polling, notifications) — jobs table + cron, no Cloudflare Queues.
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  projectId TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL CHECK (type IN ('drift', 'poll', 'notify')),
  notBefore TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lastError TEXT,
  createdAt TEXT NOT NULL
);
CREATE INDEX jobs_due ON jobs(notBefore);
