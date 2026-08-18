# elf-tokens

**A CI-friendly CLI that compares your Figma design tokens against the tokens actually used in your codebase — and posts the differences as a PR comment, so drift gets caught before it ships.**

[![npm version](https://img.shields.io/npm/v/elf-tokens)](https://www.npmjs.com/package/elf-tokens)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI — Design Token Drift Checker](https://github.com/nonyonah/elf/actions/workflows/drift-checker.yml/badge.svg)](https://github.com/nonyonah/elf/actions/workflows/drift-checker.yml)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](package.json)

Design tokens are supposed to be the single source of truth for how a product looks. In practice they drift: a designer tweaks `primary/500` in Figma, the Tailwind config keeps the old hex, and nobody notices until the marketing site ships with two slightly different blues. This tool closes that loop — it diffs Figma's tokens against your codebase's tokens on every pull request and leaves the result as a comment on the PR.

**Token-value comparison only.** No screenshots, no pixel diffing, no component checks — just names and values.

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

1. **Fetch** — pull color, spacing, and typography tokens from your Figma file. Works with both the modern **Variables** API and the older **Styles** API (auto-detected: variables first, styles as fallback). Responses are cached in-memory for the run, so the token set is only ever fetched once.
2. **Parse** — read the same tokens from your codebase: a Tailwind config, CSS custom properties, or a `tokens.json`.
3. **Normalize** — both sides are reduced to the same shape: `{ name, category, value }`. Values are canonicalized so `0.75rem` and `12px` compare as equal (see [Limitations](#limitations)).
4. **Diff** — three kinds of drift are reported:
   - **Value mismatch** — same token name on both sides, different value
   - **Missing in code** — exists in Figma, not found in the codebase
   - **Missing in Figma** — exists in the codebase, not found in Figma
5. **Comment** — the markdown report is written to `drift-report.md` and (in CI) posted to the PR. The same comment is **updated** on every push — never duplicated — and removed again once the drift is fixed.

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

### 2. Fill in the config

Copy `elf.config.json` and point it at your file and your token source:

```jsonc
{
  "figma": {
    "fileKey": "YOUR_FIGMA_FILE_KEY",        // from the file URL: figma.com/design/<FILE_KEY>/...
    "apiTokenEnv": "FIGMA_API_TOKEN",        // env var the token lives in (don't put the token here!)
    "source": "auto",                        // "auto" | "variables" | "styles"
    "teamId": ""                             // only needed for Styles mode
  },
  "codebase": {
    "source": "auto",                        // "auto" | "tailwind" | "css" | "tokens-json"
    "path": "./tailwind.config.js"           // path to your token source
  },
  "modeName": null,                          // Figma variable mode; null = first mode
  "nameMapping": {}                          // figma name → code name, see below
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

---

## Live mode: Figma edits notify the repo (optional)

The PR check covers drift introduced by *code* changes. Live mode covers the other direction: when a designer changes tokens in Figma, the repo finds out without waiting for anyone to open a PR.

Figma webhooks can't authenticate to GitHub's API directly, so the hop goes through a ~30-line Cloudflare Worker bridge (included in `worker/`) that verifies the webhook's passcode and forwards the event:

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

### Setup

1. **Deploy the worker** (one-time Cloudflare login):

   ```bash
   cd worker
   npx wrangler@latest deploy
   ```

   Note the worker URL (`https://elf-tokens-bridge.<your-subdomain>.workers.dev`) and set `GITHUB_REPO` in `worker/wrangler.toml` to `owner/repo`.

2. **Set worker secrets:**

   ```bash
   npx wrangler secret put GITHUB_TOKEN    # GitHub PAT with repo scope (classic) — used for repository_dispatch
   npx wrangler secret put FIGMA_PASSCODE  # any value ≥ 8 chars; reuse it in the next step
   ```

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

---

## CLI reference

```
elf-tokens [options]
elf-tokens webhook [options]

  --config <path>     config file (default: elf.config.json)
  --out <path>        where to write the report (default: drift-report.md)
  --sample [format]   run against bundled sample data, no token needed
  --fail-on-drift     exit with code 2 when drift is found (off by default)
  --help              show usage

webhook subcommand:
  --endpoint <url>    worker URL (default: webhook.endpoint in the config)
  --list              list webhooks registered for the file
  --test              send a fake Figma event through the worker
```

Exit codes: `0` — ran (drift may or may not exist), `1` — error (bad config, missing token, network), `2` — drift found with `--fail-on-drift`.

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

Figma variables are mapped to the three supported categories heuristically:

| Figma type | Category |
|---|---|
| `COLOR` | color |
| `STRING` (font family, etc.) | typography |
| `FLOAT` with `font`/`size`/`text`/`leading`/`tracking`/`letter`/`weight` in the name | typography |
| `FLOAT` with `space`/`spacing`/`gap`/`padding`/`margin` in the name | spacing |
| `FLOAT` otherwise | spacing |
| `radius`/`border`/`shadow`/`opacity`/`easing`/`duration` | skipped |

Codebase tokens use the same keyword rules when the format doesn't declare a type explicitly. Values are canonicalized for comparison: colors to lowercase hex (`rgb()`/`hsl()`/hex all become `#rrggbb`, 8-digit hex when alpha < 1) and lengths to px (`rem` is converted assuming a 16px root). Names are slugified (`Color/Primary/500` → `color-primary-500`), and `nameMapping` handles the rest.

---

## Why I built this

Every project I've worked on has had the same arc: the design system starts as a shared Figma file, the engineers port tokens into Tailwind, and over a few sprints the two quietly diverge — a hex changed here, a spacing scale added there — until "just use the tokens" stops being true. I wanted a tool that treats the Figma file as the source of truth and makes drift visible where it's actually caught: in review. It's deliberately small — one script, one config file, no servers — because the cost of maintaining infrastructure should never exceed the cost of the problem it solves.

## Limitations — what this doesn't do (yet)

- **Values only.** No visual or pixel comparison against a live site, no component-level or layout diffing. A mismatch in *usage* (token exists everywhere, but a component hardcodes a color) is invisible to this tool.
- **Heuristic classification.** Category detection is keyword-based, and out-of-scope token types (radii, shadows, opacities) are skipped. If your naming doesn't use the expected keywords, tokens can land in the wrong category or get skipped.
- **`rem` assumes a 16px root** — if your project uses a different root font size, font/spacing comparisons will report false mismatches. Mapping in `nameMapping` won't fix a unit mismatch; only the root assumption is used.
- **Tailwind configs must be plain object literals** (`module.exports` / `export default`). Function-based configs are not supported.
- **Styles mode needs a Figma team ID** (`figma.teamId`), and only solid paint fills are read — gradients and effects are skipped.
- **One file, one token set.** Multi-mode variable collections compare only the first mode (or `modeName` if set).
- **Live mode needs a Cloudflare account** and runs on the repo's default branch only (`repository_dispatch` always executes the default branch's workflow).

## Decisions worth revisiting

- **The check never hard-fails the PR.** `--fail-on-drift` exists and exits 2, but the workflow runs without it on purpose — until the false-positive rate is understood, a bot comment should inform, not block. Once it's been in production for a while, flipping CI to `--fail-on-drift` is a one-line change (the flag is commented in the workflow).
- **Stale-comment cleanup** deletes the drift comment when the check comes back clean — if you'd rather keep history, remove the `deleteComment` branch.

## License

[MIT](LICENSE)
