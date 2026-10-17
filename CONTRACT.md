# elf dashboard contract — schema 1

The HTTP contract between **elf clients** and the **elf console** (the hosted dashboard).

| Side | Implementation | Role |
|---|---|---|
| Client — CLI / CI | `elf push` (elf-tokens repo) | Sends code snapshots after a drift check |
| Client — watcher | `elf-watch` (elf-tokens repo) | Sends code snapshots from a live session (source `watcher`) |
| Client — plugin | Elf bridge plugin (Figma) | Sends Figma snapshots on demand / on change |
| Server | elf-console | Stores snapshots, computes drift, notifies Slack, serves remote config |

**Version: 1.** Additive changes (new optional fields, new endpoints) stay in schema 1. Removing a field or changing its meaning bumps the schema.

---

## 1. Conventions

- Base path: `https://<dashboard-host>/api/v1`
- Requests and responses are UTF-8 JSON (`Content-Type: application/json`).
- Timestamps are ISO 8601 UTC with a `Z` suffix (`2026-10-17T12:00:00Z`).
- Request body limit: **2 MB** — larger → `413 too_large`.
- Rate limit: **60 requests / minute / token** — exceeded → `429 rate_limited` with a `Retry-After` header (seconds).
- Unknown fields are **ignored** (never rejected), so newer clients can talk to older servers.
- Missing or invalid required fields → `400 invalid_payload`.

## 2. Authentication

Every endpoint except `GET /health` requires a bearer token:

```
Authorization: Bearer elf_push_<random>
Authorization: Bearer elf_plugin_<random>
```

| Token kind | Prefix | Used by | Allowed endpoints |
|---|---|---|---|
| Push | `elf_push_` | `elf push`, `elf-watch` | `POST /ingest/code`, `GET /projects/me/config`, `GET /projects/me/status` |
| Plugin | `elf_plugin_` | Bridge plugin | `POST /ingest/figma` |

- Tokens are created in the dashboard per project and **shown once**. The server stores only a SHA-256 hash plus a display hint (last 4 characters).
- The token identifies the **project**; every request is scoped to it ("`me`" = the project the token belongs to).
- Missing, malformed, revoked, or wrong-kind token → `401 unauthorized`.

## 3. Error format

```json
{ "error": { "code": "invalid_payload", "message": "…", "details": { "field": "checkedAt" } } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_payload` | Required field missing or invalid |
| 401 | `unauthorized` | Missing / bad / revoked token, or wrong token kind for the endpoint |
| 413 | `too_large` | Body over 2 MB |
| 429 | `rate_limited` | Over 60 req/min — `Retry-After` header set |
| 500 | `server_error` | Unexpected failure — safe to retry |

`details` is optional and free-form.

## 4. Endpoints

### `GET /health` — no auth

```json
{ "ok": true, "schema": 1, "version": "1.0.0" }
```

### `POST /ingest/code` — push token

A **code snapshot**: what the CLI just compared, including both sides of the diff.

```json
{
  "source": "cli",
  "checkedAt": "2026-10-17T12:00:00Z",
  "git": { "branch": "main", "commit": "8f3c1a9" },
  "config": {
    "figmaFileKey": "abc123",
    "figmaSource": "variables",
    "codebaseSource": "tailwind",
    "modeStrategy": "modes",
    "modeName": null
  },
  "figmaTokens": [
    { "name": "accent-500", "category": "color", "value": "#6366f1", "mode": null }
  ],
  "codeTokens": [
    { "name": "accent-500", "category": "color", "value": "#4f46e5" }
  ],
  "components": [
    { "name": "Button", "codeKey": "src/components/Button.tsx", "specHash": "…", "nodeHash": "…" }
  ],
  "drift": { "found": true, "counts": { "valueMismatches": 1, "missingInCode": 1, "missingInFigma": 2 } },
  "report": "# Design token drift report\n…"
}
```

| Field | Required | Notes |
|---|---|---|
| `source` | yes | `"cli"` or `"watcher"` |
| `checkedAt` | yes | ISO 8601 UTC |
| `git` | no | branch + commit of the code snapshot |
| `config` | yes | which sources were read (for the UI) |
| `figmaTokens` / `codeTokens` | yes | Arrays; each item `{ name, category, value, mode? }`; may be empty |
| `components` | no | Omitted when the component check is disabled |
| `drift` | no | The client's own verdict, for reference — the server recomputes from stored snapshots |
| `report` | no | Markdown report, for display |

**Response** — `202`:

```json
{ "status": "stored", "snapshotId": "snap_01H…", "receivedAt": "2026-10-17T12:00:01Z" }
```

- `status` is `"stored"` for a new snapshot, `"deduped"` when an identical payload (same content hash) was already stored. The client exits 0 either way.
- Storing a snapshot enqueues a drift run, debounced so a burst of pushes within 10 seconds runs once.

### `POST /ingest/figma` — plugin token

A **Figma snapshot**: one reading of the file the plugin is running in.

```json
{
  "figma": { "fileKey": "abc123", "fileName": "Design System" },
  "capturedAt": "2026-10-17T12:00:00Z",
  "tokens": [
    { "name": "accent-500", "collection": "Semantic", "type": "COLOR", "mode": "Light", "value": "#6366f1" }
  ],
  "components": [
    { "name": "Button", "codeKey": "src/components/Button.tsx", "nodeHash": "…" }
  ],
  "pluginVersion": "1.0.0"
}
```

Response identical to `POST /ingest/code` (`202`, `status`, `snapshotId`). Same debounced drift run.

### `GET /projects/me/config` — push token

Remote config, merged over the local `elf.config.json` by the CLI (the dashboard wins for `deprecations`, `nameMapping`, `modeStrategy`, `modeName`).

```json
{
  "schema": 1,
  "config": {
    "deprecations": [],
    "nameMapping": {},
    "modeStrategy": "modes",
    "modeName": null
  },
  "updatedAt": "2026-10-17T09:00:00Z",
  "etag": "\"cfg-7\""
}
```

- The `etag` value is also returned as the standard `ETag` header.
- Supports `If-None-Match` → `304 Not Modified` (no body).

### `GET /projects/me/status` — push token

```json
{
  "state": "drift",
  "checkedAt": "2026-10-17T12:00:05Z",
  "counts": {
    "valueMismatches": 1,
    "missingInCode": 1,
    "missingInFigma": 2,
    "componentsOutOfDate": 0,
    "componentsChangedInFigma": 0,
    "componentsInCodeNotInFigma": 0,
    "componentsInFigmaNotInCode": 0,
    "deprecationOverdue": 0
  },
  "reportUrl": "https://<dashboard-host>/projects/<id>"
}
```

- `state`: `ok` | `drift` | `stale` | `unknown`.
- `counts` mirrors the drift categories the CLI reports.

## 5. Client behavior (normative)

- **Retries**: on network errors and `429` / `5xx`, retry up to **3 attempts total** with exponential backoff, honoring `Retry-After` when present. Never retry `400` or `401`.
- **Push never breaks the check**: `elf push` failing (missing token, network down, server error) never turns a normal drift check into a failing run — the check's own exit code is unchanged.
- **Exit codes** for `elf push`: `0` — sent or deduped; `1` — failed after retries. `--dry-run` prints the payload and exits `0`.

---

## Review checklist (assumptions to confirm)

- Payload field names: `figmaTokens` / `codeTokens`, `drift.counts` keys, `snapshotId` format
- Dedupe scope: same content hash per project + snapshot kind
- `GET /projects/me/config` response shape (nested `config` object) and `ETag` handling
- `source` values: `cli` | `watcher` (plugin implied by the endpoint)
- Whether `report` (markdown) should ride the push or be regenerated server-side from elf core
