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

Better Auth owns its own tables (`user`, `session`, `account`, `verification`) in the same D1 database; its migrations run alongside ours.

## Auth

- **Better Auth** (Workers-native, D1 adapter): Google OAuth + email magic link.
- Email delivery via **Resend** (API key as a Worker secret).
- httpOnly cookie sessions; nothing in localStorage.
- First sign-in creates a workspace + membership.
- Local development runs with placeholder credentials; real Google OAuth client + Resend key are wired at deploy time.

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
| 1 | Sign in | Google + email magic link |
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

- Vitest + `@cloudflare/vitest-pool-workers` (Miniflare) against real D1 migrations.
- Coverage: ingest (validation, dedupe, rate limiting, 2 MB cap, token-kind auth), drift runs, remote config ETag, **tenant isolation** (workspace A can never touch workspace B), secret redaction in logs and responses.

## Order of work (stop for review after each step)

1. Repo setup: wrangler + D1 schema & migrations, Better Auth, workspace helper, secrets (AES-GCM), token issuing
2. Ingest endpoints, snapshot storage, drift runs, status + config endpoints
3. Overview + Project screens, Connections, Deprecations
4. Polling (15 min), Slack notifications, Activity, Settings

## Out of scope for schema 1

- Cloudflare Queues (jobs table + cron instead), Figma Variables REST API (plan-gated), multiple workspaces per user, billing, SSO beyond Google, notification channels beyond Slack.

---

## Review checklist (assumptions to confirm)

- `stale` threshold and semantics
- Designer/developer toggle: same data, different density/terminology?
- Token UX in Settings: issue per project, show once, revoke; who can see last-used?
- Which actions land in the audit log
- Anything to add to the out-of-scope list
