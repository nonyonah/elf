# elf-console

The hosted side of [elf](../elf): receives design-system snapshots from repos and Figma, computes drift with elf core, serves remote config, and notifies through Slack.

Scope and behavior: [`DASHBOARD-SCOPE.md`](./DASHBOARD-SCOPE.md). Wire protocol (`/api/v1`, schema 1): `CONTRACT.md` in the `elf` repo.

> Status: **order-of-work step 3 (awaiting review)** — the dashboard API (`/api/projects`, per-project detail live recompute, deprecations CRUD, connections with sealed secrets, audit log) and the console screens (Overview, Project, Deprecations, Connections) are built. Earlier: `CONTRACT.md` v1 ingest + drift jobs (step 2) on the Clerk/D1 shell (step 1). Notifications polling, Activity, and Settings land in step 4.

## Stack

- **Cloudflare Worker** (Hono) + **D1** (`elf-console` database) + static assets from the Vite build, one Worker.
- **Clerk** for auth (Google + email code, hosted). The Worker verifies session tokens with `@clerk/backend`; there are no auth tables in D1.
- **Vite + React** client in `client/`, built to `dist/client/`.
- **coss UI** for the console’s components — the shadcn CLI registry (`base-nova` style, Base UI primitives), vendored into `client/src/components/ui/`. This is the interim component layer: it will be migrated to elf-ui once its components are finished and released. Light-first; dark theme tokens exist but no toggle ships.
- **Vitest** with `@cloudflare/vitest-plugin` — tests run against real D1 bindings in Miniflare.

## Layout

```
src/            Worker: index.ts (routes + cron), api.ts (/api/v1, CONTRACT.md), contract.ts (validation),
                drift.ts (server-side recompute via elf core), jobs.ts (debounced jobs table), ratelimit.ts,
                auth.ts (Clerk), db/ (crypto, tokens, workspaces), env.ts
client/         Vite + React app (Overview / Project / Deprecations / Connections); components.json holds the coss registry config
migrations/     D1 migrations (schema 1: 0001_init.sql; rate limits: 0002)
test/           Worker-integration tests (real D1, injected sessions)
```

## Local development

```sh
npm install --legacy-peer-deps   # repo pins vitest@4; npm's peer resolution needs the flag
cp .dev.vars.example .dev.vars   # fills CLERK_* (optional) + SECRETS_KEY
openssl rand -base64 32          # paste into SECRETS_KEY, or generate fresh

npm run db:local                 # apply migrations to the local D1
npm run dev                      # wrangler dev — serves API + last built assets
npm run dev:client               # optional: Vite dev server with /api proxied to :8787
npm test                         # vitest (workers pool, real D1 per suite)
npm run typecheck
```

`npm run dev` serves `dist/client` for non-API routes — run `npm run build` once after cloning so the assets directory exists.

For the client dev loop, run both: `npm run dev` (worker on `:8787`) and `npm run dev:client` (Vite on `:5173`, proxy `/api` → `:8787`). The built client is checked with `npm run build`.

### Clerk

Auth is entirely hosted by Clerk:

1. Create a development instance at dashboard.clerk.com and enable **Google** and **email code** sign-in there.
2. Put the instance keys in `.dev.vars` (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`); in production they are a Worker secret and a var.
3. Set `CLERK_AUTHORIZED_PARTIES` to your console origins in production.

With `CLERK_SECRET_KEY` empty the worker still boots and `/api/health` works; every other `/api` route answers `401 unauthorized`. Tests never call Clerk — they inject fake session resolvers into `createApp()`.

The client needs the publishable key too: put `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` in `.env.local` (client env, not `.dev.vars`) or it renders the “Connect Clerk” notice and every request stays signed out.

## Secrets

| Name | Kind | Purpose |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | secret | Clerk session-token verification |
| `CLERK_PUBLISHABLE_KEY` | var | Public Clerk instance key |
| `CLERK_AUTHORIZED_PARTIES` | var | Comma-separated allowed origins |
| `SECRETS_KEY` | secret | AES-GCM key (base64, 32 bytes) for connection secrets |

Tokens minted for repos/plugin (`elf_push_…`, `elf_plugin_…`) are stored as SHA-256 + last4 only and shown once.

## Deploy

```sh
wrangler d1 create elf-console        # once; paste the real database_id into wrangler.jsonc
npm run build
npm run db:remote                     # apply migrations
wrangler secret put CLERK_SECRET_KEY
wrangler secret put SECRETS_KEY
npm run deploy
```

## Working with elf core

`src/drift.ts` imports the pure core via `"elf-tokens/core"`. Locally the dependency is `"elf-tokens": "file:../elf"` (the sibling checkout) — installed with the same `--legacy-peer-deps` flag. The import path stays stable when the package is published; a fresh clone without a sibling `../elf` needs that dependency pointed at a published version or a linked checkout.
