# elf-tokens

**A CI-friendly CLI that compares your Figma design tokens against the tokens actually used in your codebase — and reports the differences as a PR comment, a Slack alert, or both — so drift gets caught before it ships.**

[![npm version](https://img.shields.io/npm/v/elf-tokens)](https://www.npmjs.com/package/elf-tokens)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI — Design Token Drift Checker](https://github.com/nonyonah/elf/actions/workflows/drift-checker.yml/badge.svg)](https://github.com/nonyonah/elf/actions/workflows/drift-checker.yml)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

Design tokens are supposed to be the single source of truth for how a product looks. In practice they drift: a designer tweaks `primary/500` in Figma, the Tailwind config keeps the old hex, and nobody notices until the marketing site ships with two slightly different blues. This tool closes that loop — it diffs Figma's tokens against your codebase's tokens on every pull request and leaves the result as a comment on the PR.

**No screenshots, no pixel diffing.** Tokens compare by name and value; components (opt-in) compare by their parsed specs and Figma node hashes.

---

## How it works

```
┌─────────────┐   Figma REST API   ┌──────────────────────┐   reads   ┌─────────────────┐
│  Figma file │ ─────────────────► │     elf-tokens       │ ────────► │ codebase tokens │
│  (variables │   (cached in-run)  │       src/cli.ts     │           │  tailwind | css │
│   / styles) │                    └──────────┬───────────┘           │  | tokens.json  │
└─────────────┘                               │                       └─────────────────┘
                                              ▼
                              ┌──────────────────────────────┐
                              │  normalize → diff → report   │
                              └──────────────┬───────────────┘
                                             ▼
                              ┌──────────────────────────────┐
                              │  markdown report posted as   │
                              │  a single PR comment         │
                              └──────────────────────────────┘
```

1. **Fetch** — pull color, spacing, typography, radius, and shadow tokens from your Figma file. Three sources: the modern **Variables** REST API, the older **Styles** REST API, or the **bridge** (the same plugin connection the MCP server uses — works on any Figma plan). `"auto"` tries variables first, falls back to styles, and drops to the bridge when REST is blocked by a plan/permission error. Responses are cached in-memory for the run.
2. **Parse** — read the same tokens from your codebase: a Tailwind config, CSS custom properties, or a `tokens.json`.
3. **Normalize** — both sides are reduced to the same shape: `{ name, category, value }`. Values are canonicalized so `0.75rem` and `12px` compare as equal (see [Limitations](#limitations)).
4. **Diff** — token drift comes in three kinds, plus four component categories when the component check is enabled:
   - **Value mismatch** — same token name on both sides, different value
   - **Missing in code** — exists in Figma, not found in the codebase
   - **Missing in Figma** — exists in the codebase, not found in Figma (new in code, or removed from Figma without being marked deprecated — see `deprecations` below)
   - **Components out of date** — the code spec changed since the last `elf-batch` sync
   - **Components changed in Figma** — the node changed since the last sync
   - **Components in code, not in Figma** — never synced, or removed from Figma
   - **Components in Figma, not in code** — a node still carries an elf codeKey but its file is gone
5. **Comment / alert** — the markdown report is written to `drift-report.md` and (in CI) posted to the PR. The same comment is **updated** on every push — never duplicated — and removed again once the drift is fixed. With `--notify`, a summary goes to a Slack webhook instead, so the loop works with no CI at all.

### Five ways it runs

| Where | Trigger | Result |
|---|---|---|
| **Local** | `npx elf-tokens` | Report in the terminal + `drift-report.md` / `drift-status.json`. No GitHub or Cloudflare involved |
| **PR check (CI)** | every push/open/reopen of a pull request | One comment on the PR — updated on every push, deleted when clean |
| **Live webhook** | a token is edited in Figma | Figma webhook → worker (passcode check) → GitHub issue opened / updated / closed, plus a Slack ping if configured |
| **Figma plugin** | designer clicks "Check drift" inside Figma | Panel shows drift for the file it's running in, fed by the nightly `drift-data` branch |
| **Alert (no CI)** | `--notify` on any run — shell, git hook, cron | Slack (or webhook) message whenever the drift state changes |

---

## Quick start

### Option A — use it in any project (npm package)

```bash
npm install --save-dev elf-tokens
npx elf-tokens --config elf.config.json
```

`elf-tokens` has no runtime dependencies of its own to worry about — it runs wherever Node ≥ 20 does.

### Option B — run it from this repo

```bash
git clone https://github.com/nonyonah/elf.git
cd elf
npm install
```

### 1. Create a Figma token

In Figma: **Account settings → Security → Personal access tokens → Generate new token**. Scope: `Files: Read only` is enough. Treat it like a password — it goes in an environment variable, never in the repo.

### Where each credential lives

| Credential | Purpose | Where it lives |
|---|---|---|
| `FIGMA_API_TOKEN` (Figma PAT, `figd_…`) | Read tokens from Figma for every check | **Local CLI:** shell env var — `export FIGMA_API_TOKEN=figd_…` (persist in `~/.zshrc`). **GitHub Actions:** a repository secret of the same name (Settings → Secrets and variables → Actions), passed by the workflows as `${{ secrets.FIGMA_API_TOKEN }}` |
| `FIGMA_WEBHOOK_PASSCODE` | Auths webhook registration (designer → repo chain) | Your shell env while running `elf-tokens webhook`; must equal the worker's `FIGMA_PASSCODE` |
| `FIGMA_PASSCODE` | Verifies webhook events at the worker | Cloudflare worker secret: `npx wrangler secret put FIGMA_PASSCODE` |
| `GITHUB_TOKEN` | Worker → GitHub: `repository_dispatch` + drift-data reads | Cloudflare worker secret: `npx wrangler secret put GITHUB_TOKEN` — classic PAT with `repo` scope, or fine-grained with **Actions: read/write** + **Contents: read** |
| `SLACK_WEBHOOK_URL` (or any name via `notify.webhookEnv`) | `--notify` drift alerts + worker Slack pings | Shell env for the CLI (`export SLACK_WEBHOOK_URL=…`); Cloudflare worker secret for live pings. Treat the URL like the passcode — anyone holding it can post to the channel |
| `ELF_DASHBOARD_TOKEN` (`elf_push_…`) | `elf push` snapshots to the elf console dashboard | Shell/CI secret only — created once on the project's page in the console. **Never** in the config (which stores just `dashboard.url`) |
| Figma file key | Picks *which* file to check | `figma.fileKey` in `elf.config.json`, copied once from `figma.com/design/<KEY>/…`. Only the CLI/CI need it — the plugin reads its own file key automatically |

**Never** put a token or passcode inside `elf.config.json` or any committed file — the config stores only the env-var *name* (`apiTokenEnv`). Committed secrets get leaked.

Verify the token is actually picked up:

```bash
env | grep FIGMA_API_TOKEN   # is it loaded into the shell?
npx elf-tokens --sample      # CLI works (offline demo, no token needed)
npx elf-tokens               # live check against your file
```

### 2. Fill in the config

Copy `elf.config.json` and point it at your file and your token source:

```jsonc
{
  "figma": {
    "fileKey": "YOUR_FIGMA_FILE_KEY",        // from the file URL: figma.com/design/<FILE_KEY>/...
    "apiTokenEnv": "FIGMA_API_TOKEN",        // env var the token lives in (don't put the token here!)
    "source": "auto",                        // "auto" | "variables" | "styles" | "bridge"
    "teamId": ""                             // only needed for Styles mode
  },
  "codebase": {
    "source": "auto",                        // "auto" | "tailwind" | "css" | "tokens-json"
    "path": "./tailwind.config.js"           // path to your token source
  },
  "modeName": null,                          // null = first mode | "all" | ["Light", "Dark"]
  "modeStrategy": "modes",                   // "modes" (Light/Dark) | "collections" (one mode per collection)
  "nameMapping": {},                         // figma name → code name, see below
  "components": {                            // optional — the component check (needs the bridge)
    "path": "./src/components",              // same folder elf-batch syncs
    "manifest": "./elf.manifest.json"        // same manifest elf-batch writes
  },
  "deprecations": [],                        // optional — intentional divergences, see below
  "dashboard": {                             // optional — `elf push` snapshots to the elf console
    "url": "https://your-elf-console.example.com",
    "projectId": "proj_…"                    // optional — from the console's project page
  },
  "notify": {                                // optional — where --notify posts alerts
    "webhookEnv": "SLACK_WEBHOOK_URL",       // env var holding the URL (the URL itself never goes here)
    "format": "slack"                        // "slack" (Block Kit) | "text" (plain body, e.g. ntfy)
  }
}
```

`nameMapping` bridges the gap when naming conventions differ. Figma names are slugified before matching (`Color/Primary/500` → `color-primary-500`), so map from the slugified form:

```json
{
  "nameMapping": {
    "color-primary-500": "primary-500",
    "color-primary-400": "primary-400"
  }
}
```

`components` turns on the component half of the check. Point `path` and `manifest` at the folder and `elf.manifest.json` that [`elf-batch`](batch/) syncs (both paths resolve relative to the config file). Figma is read through the bridge, so the `mcp` server and the Elf bridge plugin must be running — the check fails with a clear message if they aren't.

`deprecations` records divergences you *meant* to make — a token that moved to code-only, a component waiting to be retired:

```json
{
  "deprecations": [
    { "name": "color-legacy-500", "type": "token", "reason": "replaced by color-primary-500", "since": "2026-01-01" },
    { "name": "OldButton", "type": "component", "reason": "replaced by Button", "removeBy": "2026-09-01" }
  ]
}
```

A deprecated item that is missing from Figma but still in code is reported as **Deprecated (still in code)** — informational, it does not count as drift. Once `removeBy` is in the past it becomes **Deprecation overdue** and counts (with `--fail-on-drift`, it exits 2). When the item disappears from the code, the report suggests dropping its entry (**Safe to remove from the deprecations list**). `type: "component"` entries match by component name or codeKey.

### 3. Run it locally

```bash
export FIGMA_API_TOKEN=your_token_here
npx elf-tokens
```

No token handy (or just want to see it work)? Sample data is bundled:

```bash
npx elf-tokens --sample                 # variables vs. tailwind
npx elf-tokens --sample css             # variables vs. CSS custom properties
npx elf-tokens --sample tokens-json     # variables vs. tokens.json
npx elf-tokens --sample styles          # styles API vs. tailwind
```

The report is printed to the terminal and written to `drift-report.md` (plus a machine-readable `drift-status.json`). The check **always exits 0** unless you pass `--fail-on-drift` (exit code 2) — see the decision note below.

### 4. Wire it into GitHub Actions

Add `FIGMA_API_TOKEN` as a [repository secret](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions) (Settings → Secrets and variables → Actions), commit your filled-in `elf.config.json`, and the included [workflow](.github/workflows/drift-checker.yml) handles the rest:

- runs on every PR (push, open, reopen)
- runs the check, then creates **or updates** a single comment (marked with `<!-- design-token-drift-checker -->`)
- deletes the comment when drift is resolved, so PRs stay clean
- never fails the build — the check is advisory in v1

```bash
git add elf.config.json
git commit -m "Add design token drift checker"
git push
```

### 5. Get alerts without CI (optional)

GitHub Actions is only one trigger. `--notify` posts a summary — headline, per-category counts, top 10 items — to a webhook whenever the drift state changes, and it works on any machine with Node ≥ 20:

```bash
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…
npx elf-tokens --notify
```

Slack incoming webhooks are free, need no Slack app, and one URL is all the setup there is. The same JSON also works with Discord (append `/slack` to the webhook URL); `"format": "text"` posts a plain body anywhere else (ntfy, etc.). The URL lives in the environment variable named by `notify.webhookEnv` — never in the config, never in the logs.

Alerts are deduped: a first report with drift (or deprecation notes), any later change, and a "drift resolved" message when it clears — nothing on repeat runs with the same state. The state lives in `drift-status.json` next to the report; set `notify.stateFile` to keep it somewhere else. If a post fails, the state is not advanced, so the next run retries.

Want to see the whole alert lifecycle without a Slack workspace? The bundled drill runs real checks against sample data with a local capture server standing in for the webhook:

```bash
npm run notify:drill   # posts, dedupes, re-alerts on change, retries a failed post
```

Ways to run it with no GitHub involved:

```bash
# pre-push hook (.git/hooks/pre-push, chmod +x)
#!/bin/sh
npx elf-tokens --notify >/dev/null 2>&1 || true

# cron — one alert a morning, only when something changed
0 9 * * * cd /path/to/repo && npx elf-tokens --notify
```

And for the design side, the [live-mode worker](#live-mode-figma-edits-notify-the-repo-optional) pings Slack directly on every accepted Figma event when `SLACK_WEBHOOK_URL` is set — no `repository_dispatch`, no Actions required.

---

## Live mode: Figma edits notify the repo (optional)

The PR check covers drift introduced by *code* changes. Live mode covers the other direction: when a designer changes tokens in Figma, the repo finds out without waiting for anyone to open a PR.

Figma webhooks can't authenticate to GitHub's API directly, so the hop goes through a ~60-line Cloudflare Worker bridge (included in `worker/`) that verifies the webhook's passcode and forwards the event:

```
┌──────────┐  webhook POST  ┌───────────────────────┐  dispatch POST  ┌───────────────────────┐
│ Figma    │ ─────────────► │ Cloudflare Worker     │ ──────────────► │ GitHub Actions        │
│ file     │   (passcode)   │ verifies, forwards    │  (Bearer PAT)   │ figma-drift-watch.yml │
└──────────┘                └───────────────────────┘                 └───────────┬───────────┘
                                                                                   ▼
                                                                opens / updates / closes
                                                                a "design token drift"
                                                                issue with the report
```

### The Figma plugin (drift inside Figma)

The worker's `GET` route also serves the latest drift data to the bundled Figma plugin (`plugin/`), closing the loop in the design tool itself — each Figma file checks *its own* code, because the plugin reads the file key it's running in:

```
┌──────────┐    GET /?fileKey=…&passcode=…   ┌───────────────────────┐  raw fetch   ┌──────────────────┐
│ Figma    │ ──────────────────────────────► │ Cloudflare Worker     │ ────────────► │ drift-data branch│
│ plugin   │  (drift status for THIS file)   │ verifies, proxies     │  (Bearer PAT)│ (pushed nightly) │
└──────────┘                                 └───────────────────────┘               └──────────────────┘
```

The plugin shows the file name + key it's running in, the worker URL and passcode (saved per file via `setPluginData`, so each file's association is independent — no central mapping to maintain), and on **Check drift** renders: in-sync/drift badge, value-mismatch / missing-in-code / missing-in-Figma counts, the last check time, and the full report.

The data it reads comes from the `drift-data` branch, refreshed daily by `.github/workflows/drift-data.yml` (or on demand via its `workflow_dispatch` trigger).

**Load the plugin in Figma:** Plugins → Development → New plugin → *Link existing plugin* → pick `plugin/manifest.json` from this repo. The plugin fetch is browser-CORS; the worker already answers with `Access-Control-Allow-Origin: *`.

### Setup

1. **Deploy the worker** (one-time Cloudflare login):

   ```bash
   cd worker
   npx wrangler@latest deploy
   ```

   Note the worker URL (`https://elf-tokens-bridge.<your-subdomain>.workers.dev`) and set `GITHUB_REPO` in `worker/wrangler.toml` to `owner/repo`.

2. **Set worker secrets:**

   ```bash
   npx wrangler secret put GITHUB_TOKEN        # GitHub PAT with repo scope (classic) — used for repository_dispatch
   npx wrangler secret put FIGMA_PASSCODE      # any value ≥ 8 chars; reuse it in the next step
   npx wrangler secret put SLACK_WEBHOOK_URL   # optional — ping Slack on every accepted event
   ```

   The worker also works in **Slack-only mode**: with `SLACK_WEBHOOK_URL` set and `GITHUB_REPO` / `GITHUB_TOKEN` absent, events are still acknowledged and ping Slack (`forwarded: false`) — handy when Actions is unavailable. `PING` events never ping Slack.

3. **Register the Figma webhooks** with the same passcode in your environment:

   ```bash
   export FIGMA_WEBHOOK_PASSCODE=<the value from step 2>
   npx elf-tokens webhook --endpoint https://elf-tokens-bridge.<your-subdomain>.workers.dev
   ```

   This subscribes the file to `FILE_VARIABLES_UPDATE`, `FILE_VARIABLES_CREATE`, and `FILE_VARIABLES_REMOVE` (overridable via `webhook.eventTypes` in `elf.config.json`). It's idempotent — re-running updates instead of duplicating. If you skip the env var, a passcode is generated and printed; set it as the worker's `FIGMA_PASSCODE` secret afterwards.

4. **Commit the receiving workflow** — `.github/workflows/figma-drift-watch.yml` triggers on `repository_dispatch` with type `figma-tokens-updated`, runs the check, and:
   - opens a **"Design token drift: Figma vs codebase"** issue with the report (updating and reopening the same issue on repeat drift — never duplicates),
   - closes it with a ✅ comment once the tokens are back in sync,
   - needs the same `FIGMA_API_TOKEN` secret as the PR check.

5. **Test the whole chain:**

   ```bash
   npx elf-tokens webhook --test
   ```

   This sends a fake Figma event through your worker; a drift check run should appear on the repo's Actions tab. You can also check what's registered with `npx elf-tokens webhook --list`.

6. **Enable the nightly drift data** (for the plugin) — the `drift-data` workflow is committed; it runs daily at 04:00 UTC and force-pushes `drift-report.md` + `drift-status.json` to the `drift-data` branch. Trigger it once with **Actions → Publish Drift Data → Run workflow**, then open the plugin in Figma and hit **Check drift**.

---

## Write into Figma from your AI client (local MCP)

The CLI reads. The MCP server in [`mcp/`](mcp/) **writes** — variables and basic components, driven from Cursor, Claude Desktop, or the **web** versions of Claude and Grok (free plans supported, via the Streamable HTTP transport + a tunnel), all through the Figma **Plugin API**, so it works on free/Professional Figma plans (the REST Variables API is Enterprise-only and is never called).

```
MCP client ──stdio──► mcp/ server ──ws://127.0.0.1:8765──► bridge-plugin UI ──postMessage──► Plugin API
```

- **Tools:** `status`, `list_collections`, `list_variables`, `create_collection`, `upsert_variables` (arrays, upsert by name), `rename_variable`, `delete_variable`, `list_components`, `upsert_component` (with instance children), `upsert_component_set`, `upsert_text_style`, `upsert_effect_style`, `get_node`.
- **Safe by construction:** every write is an upsert matched by name/`codeKey`, every touched node returns its Figma id, everything is tagged `setSharedPluginData("elf", "codeKey", …)`, the socket binds to `127.0.0.1` with a shared token, and Figma's plan-limit errors come back word for word.

Setup, tool reference and a manual test checklist: **[`mcp/README.md`](mcp/README.md)**.

---

## Push a whole library (local batch CLI)

The `elf-batch` CLI in [`batch/`](batch/) drives the same bridge from a config file: primitives → semantic tokens → text/effect styles, then every component in dependency order in resumable chunks (parsed from `.tsx`/`.jsx`/`.vue`/`.svelte`/`.astro` sources plus `<Name>.figma.json` sidecars), tracking an `elf.manifest.json` so re-runs only write what changed.

```
npm --prefix batch install
npm --prefix batch start -- --dry-run     # plan; nothing is written
```

Config, token/sidecar formats and manual checklist: **[`batch/README.md`](batch/README.md)**.

---

## Push snapshots to the elf console (optional)

`elf push` sends a **code snapshot** — both token sides, the component manifest, the drift verdict and the report — to the [elf console dashboard](CONTRACT.md), so the whole team sees the same drift state without opening CI logs. It runs the same check internally, then POSTs to `POST /api/v1/ingest/code`:

```bash
export ELF_DASHBOARD_TOKEN=elf_push_…   # created once on the project's page in the console
npx elf push                            # or: npx elf-tokens push
npx elf push --dry-run                  # print the exact JSON payload, send nothing
npx elf push --url https://…            # override dashboard.url for this run
```

- The dashboard URL comes from `dashboard.url` in `elf.config.json`; the **token only ever comes from the environment** (`ELF_DASHBOARD_TOKEN`) — never from the config.
- Sends with retries: up to 3 attempts, backing off on network errors, `429` and `5xx`, honoring `Retry-After`. `400`/`401` are never retried.
- Exit codes: `0` sent (or deduped), `1` failed. **A failed push never affects a normal drift check** — they are separate commands.
- The full HTTP contract (schema 1): [`CONTRACT.md`](CONTRACT.md).

---

## The pure core (`elf-tokens/core`)

Everything above reads Figma and the filesystem. The comparison itself — normalize → classify → diff → deprecations → report — is pure logic and lives in `src/core/`, importable on its own:

```ts
import { diffTokens, applyDeprecations, buildReport, buildNotifyMessage } from "elf-tokens/core";
```

The core has no imports outside itself — no Node built-ins, no `process`, no `console`, no network — enforced by [`test/core-purity.test.ts`](test/core-purity.test.ts). That keeps it runnable in any JavaScript runtime: the CLI and the elf console dashboard compute drift from the same code. It exports the normalization toolkit (`slugify`, `cssColorToHex`, `normalizeShadow`, `toPx`, …), classification (`categoryFromName`), `diffTokens` / `hasDrift`, `applyDeprecations`, `buildReport` / `buildStatusPayload`, and the Slack / plain-text formatter (`decideNotification`, `driftFingerprint`, `buildNotifyMessage`). The CLI-facing halves of those flows — reading files, calling Figma, posting webhooks — stay in `src/`.

The HTTP contract those pieces feed (snapshots, ingest, remote config) is **[`CONTRACT.md`](CONTRACT.md)**.

---

## Troubleshooting

**"Figma API token not found. Set the FIGMA_API_TOKEN environment variable"**
The CLI reads the token from the environment of whatever process runs it, nothing else. A GitHub repository secret does **not** reach your local shell (and a local `export` does not reach the workflows). Place `figd_…` locally per the credential table above, and the same-named repository secret for CI. If the error persists locally, check whether the token was ever generated (`env | grep FIGMA_API_TOKEN`).

**GitHub Actions jobs never start** — the run record exists but shows *"The job was not started because your account is locked due to a billing issue"*. That annotation is GitHub account config (Settings → Billing), not this tool — no workflow can run until it's resolved. The check itself runs fine locally meanwhile.

**Plugin shows "no drift data yet"** — the `drift-data` branch hasn't been seeded. Run **Actions → Publish Drift Data → Run workflow** once (or wait for the nightly run), then hit Check drift again.

**`webhook --test` fails with a GitHub error from the worker** — the worker's `GITHUB_TOKEN` needs perms for `repository_dispatch`: classic PAT with `repo`, or fine-grained with **Actions: read/write**. A token with Actions: read only fails with 403 *"Resource not accessible by personal access token"*.

**Value mismatches that look like false positives** — `rem` values assume a 16px root; if your project uses another root font size, convert or accept those entries (see Limitations).

**"The Figma bridge is not connected"** — a token check configured with `"source": "bridge"` (or the component check) needs the local bridge: run `npm --prefix mcp run start:http` and open the Elf bridge plugin in the Figma file. See [`mcp/README.md`](mcp/README.md) for setup.

**`--notify` fails with "Webhook URL not found"** — the URL is read from the environment variable named by `notify.webhookEnv` (e.g. `SLACK_WEBHOOK_URL`), never from the config itself. Export it locally, or add it as a repository secret in CI.

**`--notify` ran but nothing was posted** — that's the dedupe: alerts fire only when the drift state changes, so `No notification sent: drift state unchanged` means the previous `drift-status.json` (or `notify.stateFile`) already describes this exact state. Delete that file to force a fresh first report.

---

## CLI reference

```
elf-tokens [options]
elf-tokens push [options]
elf-tokens webhook [options]

  --config <path>     config file (default: elf.config.json)
  --out <path>        where to write the report (default: drift-report.md)
  --sample [format]   run against bundled sample data, no token needed
  --fail-on-drift     exit with code 2 when drift is found (off by default)
  --notify            post a summary to notify.webhookEnv, only when the
                      drift state changed since the last run
  --help              show usage

push subcommand:
  --dry-run           print the exact JSON payload and exit 0 without sending
  --url <url>         dashboard base URL (default: dashboard.url in the config)
                      token: ELF_DASHBOARD_TOKEN environment variable

webhook subcommand:
  --endpoint <url>    worker URL (default: webhook.endpoint in the config)
  --list              list webhooks registered for the file
  --test              send a fake Figma event through the worker
```

Exit codes: `0` — ran (drift may or may not exist), `1` — error (bad config, missing token, network), `2` — drift found with `--fail-on-drift`. The npm package installs both `elf-tokens` and `elf` — same CLI, either name.

---

## Example PR comment

What the bot leaves on your PR when something drifts:

> ## Design token drift report
>
> Checked **16** Figma tokens (variables) against **17** codebase tokens (tailwind) at 2026-08-18T11:16:09Z.
>
> ### Summary
>
> | Check | Count |
> |---|---|
> | Value mismatches (same name, different value) | 1 |
> | Missing in code (in Figma, not in the codebase) | 1 |
> | Missing in Figma (in the codebase, not in Figma) | 2 |
> | **Total drift** | **4** |
>
> ### Value mismatches
>
> | Token | Category | Figma | Code |
> |---|---|---|---|
> | `accent-500` | color | `#6366f1` | `#4f46e5` |
>
> ### Missing in code
>
> | Token | Category | Value (Figma) |
> |---|---|---|
> | `info-500` | color | `#3b82f6` |
>
> ### Missing in Figma
>
> | Token | Category | Value (code) |
> |---|---|---|
> | `success-500` | color | `#22c55e` |
> | `font-size-display` | typography | `64px` |

When everything matches, the previous drift comment (if any) is deleted and no new one is posted.

---

## How tokens are classified

Figma variables are mapped to the five supported categories heuristically:

| Figma type | Category |
|---|---|
| `COLOR` | color |
| `STRING` (font family, etc.) | typography |
| `FLOAT` with `font`/`size`/`text`/`leading`/`tracking`/`letter`/`weight` in the name | typography |
| `FLOAT` with `space`/`spacing`/`gap`/`padding`/`margin` in the name | spacing |
| `FLOAT` with `radius`/`corner`/`rounded` in the name | radius |
| `FLOAT` otherwise | spacing |
| Names containing `opacity`/`easing`/`duration` | skipped |

Radius tokens compare as px. Shadows come from Figma effect styles and CSS/Tailwind `box-shadow` values; both sides are normalized to one canonical string (`[inset ]x y blur spread #color`), so the same shadow written two ways compares equal — unparseable values are skipped rather than guessed.

Codebase tokens use the same keyword rules when the format doesn't declare a type explicitly. Values are canonicalized for comparison: colors to lowercase hex (`rgb()`/`hsl()`/hex all become `#rrggbb`, 8-digit hex when alpha < 1) and lengths to px (`rem` is converted assuming a 16px root). Names are slugified (`Color/Primary/500` → `color-primary-500`), and `nameMapping` handles the rest.

---

## Why I built this

Every project I've worked on has had the same arc: the design system starts as a shared Figma file, the engineers port tokens into Tailwind, and over a few sprints the two quietly diverge — a hex changed here, a spacing scale added there — until "just use the tokens" stops being true. I wanted a tool that treats the Figma file as the source of truth and makes drift visible where it's actually caught: in review. It's deliberately small — one script, one config file, no servers — because the cost of maintaining infrastructure should never exceed the cost of the problem it solves.

## Limitations — what this doesn't do (yet)

- **Specs, not pixels.** The component check compares parsed component specs (`specHash`) and Figma node hashes against the `elf-batch` manifest — it catches spec and structure changes, but not rendering differences. Moving a node on the canvas is not drift (position is stripped from the hash). A mismatch in *usage* (a component hardcodes a color) is still invisible to this tool.
- **Heuristic classification.** Category detection is keyword-based, and out-of-scope token types (opacity, easing, duration) are skipped. If your naming doesn't use the expected keywords, tokens can land in the wrong category or get skipped.
- **`rem` assumes a 16px root** — if your project uses a different root font size, font/spacing comparisons will report false mismatches. Mapping in `nameMapping` won't fix a unit mismatch; only the root assumption is used.
- **Tailwind configs must be plain object literals** (`module.exports` / `export default`). Function-based configs are not supported.
- **Styles mode needs a Figma team ID** (`figma.teamId`), and reads solid paint fills plus drop/inner shadow effects — gradients are skipped.
- **One file, one token set.** Multi-mode collections compare the first mode by default; set `modeName` to `"all"` or a list (mismatches are labelled with the mode), or `modeStrategy: "collections"` to treat every collection as one mode.
- **Component checks need the bridge** (the `mcp` server + Elf bridge plugin running in the open file). Token-only checks work with REST or the bridge.
- **Live mode needs a Cloudflare account** and runs on the repo's default branch only (`repository_dispatch` always executes the default branch's workflow).

## Decisions worth revisiting

- **The check never hard-fails the PR.** `--fail-on-drift` exists and exits 2, but the workflow runs without it on purpose — until the false-positive rate is understood, a bot comment should inform, not block. Once it's been in production for a while, flipping CI to `--fail-on-drift` is a one-line change (the flag is commented in the workflow).
- **Stale-comment cleanup** deletes the drift comment when the check comes back clean — if you'd rather keep history, remove the `deleteComment` branch.

## License

[MIT](LICENSE)
