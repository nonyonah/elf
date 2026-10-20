# elf-console — scope (schema 1)

The hosted side of elf: one place where every project's design data lands, drift is computed and tracked over time, and designers and developers finally see the same truth.

**Stack:** Cloudflare Worker + D1 (SQLite) + a Vite/React front end served as static assets by the same Worker. Local-first development with Miniflare; deploy to Cloudflare later. Uses the elf design system from the component repo.

---

## Users and model

- One user belongs to one workspace (created automatically on first sign-in).
- A workspace has many projects. A project = one code repository + one Figma file.
- Every table is workspace-scoped; every query filters by workspace.
- Tokens are per project: push token (`elf_push_…`) and plugin token (`elf_plugin_…`).
- Connections are per project: `figma` (REST reads) and `slack` (incoming webhook URL, encrypted).

## Data model (D1)

All tables carry `workspaceId` (directly or via `projectId`) and are queried with it.

| Table | Purpose | Key columns |
|---|---|---|
| workspaces | tenant root | id, name, createdAt |
| members | user ↔ workspace | userId, workspaceId, role |
| projects | one per codebase + Figma file | id, workspaceId, name, slug |
| connections | encrypted outbound creds | id, projectId, type (`figma`\|`slack`), encryptedSecret, iv, meta, status, statusMessage |
| figma_sources | file binding + poll state | projectId, fileKey, fileName, lastVersion, lastModifiedAt, lastPolledAt |
| tokens | access tokens | id, projectId, kind (`push`\|`plugin`), hash, last4, createdAt, lastUsedAt, revokedAt |
| snapshots | ingested payloads | id, projectId, kind (`code`\|`figma`), source, contentHash, payload (JSON), gitBranch, gitCommit, createdAt |
| drift_runs | one per computed diff | id, projectId, state (`ok`\|`drift`\|`stale`\|`unknown`), counts (JSON), triggeredBy, createdAt |
| deprecations | remote config entries | id, projectId, name, type, reason, since, removeBy |
| notification_rules | Slack behavior | projectId, mode (`change`\|`always`\|`never`), overdueAlways (bool) |
| audit_log | who did what | id, workspaceId, actor, action, detail, createdAt |
| jobs | deferred work | id, projectId, type (`drift`\|`poll`\|`notify`), notBefore, attempts, lastError |

Clerk hosts all auth state; there are no auth tables in D1. `members.userId` stores the Clerk user id (`user_…`).

## Auth

- **Clerk** (hosted): Google OAuth + email code, configured in the Clerk dashboard — no OAuth code or email delivery in this repo.
- The Worker verifies every `/api` request with `@clerk/backend` (`authenticateRequest`, session-token JWTs/cookies). The secret key is a Worker secret; the publishable key is public.
- First authenticated request lazily provisions a workspace + membership (signed-out traffic creates nothing).
- Without `CLERK_SECRET_KEY` the worker still boots locally: auth-required routes answer `401`.
- The client uses Clerk's React SDK (Sign in screen); nothing in localStorage.

## Secrets handling

- Slack webhook URLs (and any future outbound credential) are AES-GCM encrypted at rest with a random IV per value; the key is a Worker secret.
- Secrets are **write-only** through the API: never returned, never logged; the UI shows a masked tail (…last4) + Replace.
- Access tokens: 32 random bytes, shown **once**; only SHA-256 hash + last 4 stored.
- Tests grep logs and responses for secret material.

## Ingest and drift

- Implements the elf dashboard contract, schema 1 — see `CONTRACT.md` in the elf-tokens repo.
- Pipeline: validate → dedupe by content hash → store snapshot → enqueue drift job (debounced 10 s) → `202`.
- Jobs run via `ctx.waitUntil` from a **jobs table + cron every minute**. No Cloudflare Queues. Retries tracked with `attempts` / `lastError`.
- Drift runs use **elf core** (`elf-tokens/core`, linked locally in dev — documented in README).
- States:
  - `ok` — last run found no drift
  - `drift` — last run found drift
  - `stale` — no fresh data (see threshold below), UI nudges "open the file with the bridge plugin to refresh"
  - `unknown` — no snapshots yet, or the last run failed

## Polling

- Cron every 15 minutes: for each Figma connection, check the file's last-modified time and version via the Figma REST **Files** endpoint only — never the Variables REST endpoints (plan-gated).
- On a newer version: mark the project stale so the UI asks the designer to open the file with the bridge plugin (which can push a fresh snapshot).
- Permission/plan errors: store the message on the connection (`statusMessage`) — no retry loops.

## Notifications (Slack)

- Per-project incoming webhook, encrypted; **Send test message** button on the Connections screen.
- Message formatter comes from **elf core** (same format as `elf-tokens --notify`).
- Rules: `change` (default) / `always` / `never`; **deprecation overdue always notifies** regardless of rule.
- Messages link to the project page.

## Screens

| # | Screen | Contents |
|---|---|---|
| 1 | Sign in | Google + email code (Clerk-hosted UI) |
| 2 | Overview | All projects: state, last activity, token/component counts, attention list |
| 3 | Project | Drift state, trend chart, latest run: token + component tables; designer/developer toggle |
| 4 | Deprecations | List + add/edit; **Export elf.config.json** button |
| 5 | Connections | Figma + Slack: status, masked secrets, test, Replace |
| 6 | Activity | Audit log feed |
| 7 | Settings | Workspace, members, tokens (issue/revoke, per project) |

## Design system

- Built with the elf design system: `@rift/react` + `@rift/tokens`, linked locally from the component repo (`elf-ui`), documented in the README.
- Colors, sizes, fonts only via tokens — no raw values.
- Light + dark; keyboard and focus behavior checked on every interactive element.
- Missing pieces → `DESIGN-SYSTEM-GAPS.md`, built on Base UI primitives following `skills/elf-design-system/SKILL.md`.

## Tests

- Vitest + `@cloudflare/vitest-plugin` (Miniflare) against real D1 migrations.
- Coverage: ingest (validation, dedupe, rate limiting, 2 MB cap, token-kind auth), drift runs, remote config ETag, **tenant isolation** (workspace A can never touch workspace B), secret redaction in logs and responses.

## Implemented in step 2 (server-side drift recompute)

Per CONTRACT.md the server recomputes drift from stored snapshots with elf core. Schema-1 semantics, exactly as implemented:

- **Tokens**: exact — `diffTokens` + `applyDeprecations` over the latest code snapshot's `figmaTokens`/`codeTokens` (the CLI fetched Figma live at push time; a Figma snapshot alone cannot be diffed without a code side, so that project reads `unknown`).
- **Components**: recomputed when a Figma snapshot exists — membership by `codeKey` (name fallback), `changedInFigma` by `nodeHash`, `outOfDate` by `specHash` change since the previous code snapshot while the node stayed put (approximation; the CLI manifest stays authoritative). No Figma snapshot → component sections stay empty.
- **nameMapping**: `{}` server-side in schema 1 (not pushed, not stored) — the server's token diff can therefore report mismatches a locally name-mapped CLI run would not. The CLI's own `drift.counts` in the payload remains the reference.
- **Remote config**: the dashboard serves `deprecations` + `nameMapping` (both from its own tables; nameMapping empty in schema 1). `modeStrategy`/`modeName` are **not** served — no console storage — so the local file keeps them (CLI merge skips absent fields).
- **`stale`**: any project whose newest snapshot is older than 24 h reads `stale` (step 4's polling adds version-change detection on top).
- **Job flow**: ingest → snapshot stored → one debounced drift job per project (10 s window, pushed back while pushes keep coming) → run by the once-a-minute cron, or ~10 s after ingest via `ctx.waitUntil` kick. Claiming a job is a delete, so cron and kick can never double-run.
- **Rate limiting** is D1-backed (fixed 60 s window per token, table `rate_limits`) so all isolates share the counter.
- `snapshotId` format: `snap_<uuid>` (the contract's `snap_01H…` example is illustrative — flagged for review).

## Order of work (stop for review after each step)

1. Repo setup: wrangler + D1 schema & migrations, Clerk session verification, workspace helper, secrets (AES-GCM), token issuing
2. Ingest endpoints, snapshot storage, drift runs, status + config endpoints
3. Overview + Project screens, Connections, Deprecations
4. Polling (15 min), Slack notifications, Activity, Settings

## Out of scope for schema 1

- Cloudflare Queues (jobs table + cron instead), Figma Variables REST API (plan-gated), multiple workspaces per user, billing, SSO beyond Google, notification channels beyond Slack.

---

## Review checklist (assumptions to confirm)

- `stale` threshold (24 h for now) and semantics
- Server recompute uses `nameMapping: {}` — acceptable until the console stores mappings?
- `snapshotId` format `snap_<uuid>` vs the contract's ULID-ish example
- Designer/developer toggle: same data, different density/terminology?
- Token UX in Settings: issue per project, show once, revoke; who can see last-used?
- Which actions land in the audit log
- Anything to add to the out-of-scope list
