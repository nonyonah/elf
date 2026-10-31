# Local beta release candidate — readiness report

Date: 2026-10-31 · Prepared by automated review, ready for Codex._

## 1. Isolated checkout

- Path: `/Users/macintoshhd/Work/elf-beta` (git worktree, branch `beta/local-rc`).
- Baseline commit: `4e8c835` "Normalize CSS RGB channels before verifying Figma writes" (HEAD of main at preparation time).
- Original workspace `/Users/macintoshhd/Work/elf` untouched: staged index (22 files) and unstaged edits (28 files + untracked) preserved exactly.
- Candidate diff is left UNCOMMITTED in the worktree for review.

### Included changes (22 files: 16 modified, 6 new)

Local drift ownership + scoped sync (unstaged source):
| Change | File |
|---|---|
| autoScope + scoped build/apply/fingerprint + snapshot kwargs + nodeReads tally + deletion detection (managedByNode, fileFor) | `src/project.ts`, `src/components.ts` |
| watcher changedPaths funnel into autoSync | `src/start.ts` |
| regression tests (13 new/updated including watcher scoping, deletion, managed drift, scoped reads, remote + connection fingerprint exclusions) | `test/project.test.ts`, `test/components.test.ts` |
| manifest-managed drift regression | `test/components.test.ts` |

Local Settings/MCP status (staged source):
| Change | File |
|---|---|
| `/api/mcp-status` endpoint + BridgeClient presence probe | `src/settings.ts` |
| bridge `__elf_mcp_status` method | `mcp/src/bridge.ts` |
| presence status test | `mcp/test/presence.test.ts` |
| Settings "MCP assistants" card + wiring | `settings-next/src/components/mcp-connections.tsx` (new), `settings-next/src/app/page.tsx` |
| mcp-status integration test | `test/settings.test.ts` |
| extension version 0.3.24 → 0.3.25 | `extension/package.json` |

Docs/evidence:
| Change | File |
|---|---|
| local-first MCP positioning, hosted deferred | `README.md`, `docs/mcp-setup.md` |
| release scope + boundary reworded self-contained ("unfinished hosted MCP authorization work", no branch reference), open gates documented | `docs/production-readiness.md` |
| live acceptance record (drift ownership + scoped sync evidence) | `docs/acceptance-2026-10-30.md` (untracked in original) |

### Deliberately excluded from the release delta (preserved in the original workspace)

- Hosted MCP authorization work in progress: `console/src/hosted/plugin-auth.ts` (untracked), `console/migrations/0008_hosted_plugin_authorization.sql`, `console/test/hosted-plugin-auth.test.ts` (the known red test), `console/client/settings.html`, `console/client/src/*` changes, `console/src/hosted/*` (staged + unstaged), `console/migrations/0007_hosted_assistants.sql`, `console/vite.config.ts`, `console/package*.json`, `scripts/prepare-hosted-preview.mjs`, `docs/hosted-mcp-deployment.md`, `docs/hosted-mcp-plugin.md` deltas.
- Plugin hosted-pairing deep-link: `bridge-plugin/code.ts|code.js` (staged `/settings?elf_connection` URL change) and `bridge-plugin/ui.html` hosted-approve flow (unstaged). RC plugin stays at baseline (workers.dev root URL only).
- User artifacts and private docs (none copied): `elf.config.json` (real project config), `fixtures/tokens.css` (live-test residue), `docs/DESIGN_SYSTEM.md`, `docs/rift-labs-*` (private design-system docs + receipts), `docs/local-mcp-live-*`, `docs/managed-component-live-*`.
- Batch fixture text edits (`batch/test/fixtures/components/*.figma.json`) — confirmed non-required: batch suite passes at baseline (53/53).

### Server-side OAuth preservation

Committed Slack/Figma OAuth connection-service support (console baseline, `docs/connection-service-setup.md`, Slack workers) is unmodified and shipped; only unfinished hosted-MCP deltas are excluded.

## 2. Validation results (isolated candidate)

| Check | Result |
|---|---|
| `npm install` fresh lockfile-faithful | PASS (0 vulnerabilities) |
| `npm install --prefix settings-next` (required: root lockfile does not cover settings-next) | PASS |
| `npm run prepublishOnly` (typechecks root+mcp+settings, settings static build, brand assets, public plugin build to `dist/bridge-plugin-public/`) | PASS |
| Root `npm test` | 236/236 PASS |
| Batch suite + typecheck | 53/53 + clean PASS |
| Watch suite + typecheck | 21/21 + clean PASS |
| MCP suite + typecheck | 113/113 + clean PASS |
| `notify:drill` (local capture only, no Slack delivery) | PASS |
| `test:worker` (webhook worker) | PASS |
| Console typecheck (baseline console) | clean PASS |
| Console test suite | NOT RUN in candidate (deferred hosted work; runner requires tooling outside RC scope) |

No failures encountered in the candidate; original workspace red console test (`consent/finish` 400) is excluded from this checkout.

## 3. Package audit (packed artifact)

- Artifact: `/tmp/elf-rc-pack/elf-tokens-1.0.0.tgz` (167 entries).
- Integrity: sha512 `b0323e977b641f3db780d4667e94c6dc6c0a5795ae174ad72ffb5a20f3367a2ddd183e979a963130c9a67a8447023e43d30712716644b42ec15dc4066bb9fe70`.
- Required entries present: `package/package.json`, `package/bin/elf-tokens.js`, `package/mcp/…` (TS source, runs via bundled tsx), `package/dist/bridge-plugin-public/{manifest.json,code.js,ui.html}`, `package/dist/settings/**` (static Next build incl. brand mascot), `package/watch/…`, `package/docs/README*`.
- Forbidden-content scan: 0 hits for `.env`, `.dev.vars`, `.elf` state, real `elf.config.json`, rift-labs/private docs, acceptance artifacts; only committed baseline evidence (`docs/acceptance-2026-10-29.md`) ships via docs glob (intentional, contains no credentials/private URLs).
- Hosted exposure in shipped plugin:
  - manifest `networkAccess.allowedDomains` = `ws://localhost:8765` only;
  - no hosted-preview endpoints, no workers.dev PREVIEW tooling; baseline hosted-connector URL remains (existing product capability, not the deferred authorization work; graceful "Hosted Elf preview is not enabled yet." message intact);
  - Settings dist contains no hosted-preview references; contains the committed Slack icon CDN and the committed Bachs support-checkout URL (baseline support-payment infra, not a leak from private workspace).
- Docs hosted-first onboarding: `docs/mcp-setup.md` opens with local-first positioning, hosted deferred ✓; `docs/production-readiness.md` documents scope boundaries ✓. Supplementary baseline docs (`docs/hosted-mcp-deployment.md`, `docs/hosted-mcp-plugin.md`) still ship — they describe the preserved OAuth service, not onboarding; trimming them from the package docs glob is optional polish (not done, to keep delta minimal).

Versions observed: root `elf-tokens` 1.0.0, `mcp` 0.1.0 (surfaces as MCP `serverInfo version 0.1.0`), bridge-plugin 0.1.0, settings-next 0.1.0, extension 0.3.25.
Proposal (do not publish): release train `elf-tokens` **1.0.0-beta.1**, extension stays 0.3.25, consider aligning mcp `serverInfo` to the same train (1.0.0-beta.1) in a follow-up; root version change would invalidate the recorded artifact hash, so it must be applied and repacked if accepted.

## 4. Fresh installation validation

Environment: `/tmp/elf-fresh-beta` (empty dir, no repo node_modules; installed from packed tarball; runtime resolved to `node_modules/elf-tokens/package.json` ✓).

| Check | Result |
|---|---|
| Install | PASS (104 packages) |
| CLI `--help` | PASS (usage, subcommands incl. `extensions`, `mcp`, `bridge`, `start`) |
| `extension` discovery | PASS ("local preview … Install from VSIX", no marketplace claim, "npm remains supported") |
| First-run `start` (isolated HOME, ephemeral port) | PASS (pairs settings + pairing code UI; headless boot without crash; smoke-verified) |
| MCP over stdio via real JSON-RPC client | PASS initialize (`elf-figma` 0.1.0) + `tools/list` (19 tools) + `status` (ok, connected, plugin-verified file) |
| Unconfigured onboarding | PASS ("Figma onboarding is incomplete. Next step: select_figma_file." — isError, actionable, no secrets) |
| Plugin connected live pairing | PASS (pairing code issued and entered; approval ok; pending cleared; fresh runtime used shared bridge gracefully) |
| Useful errors without secrets | PASS (auth failure surfaces "Could not verify the bridge identity." with no token) |
| npm-to-extension instructions | PASS (shared engine, VSIX path documented) |

### Fresh-install finding (beta blocker — FIXED in this candidate)

**Default-port collision with a foreign Elf bridge was unhandled.** Fixed in `mcp/src/runtime.ts`: both acquire paths (`acquireBridge` EADDRINUSE fallback and `acquireSharedHost` first/retry connects) now map a failed handshake verification to one actionable error while preserving the fail-closed authentication checks — any non-auth error is rethrown untouched. The message tells the user exactly which port is held, that authentication was verified and rejected (never silently bypassed), and the three ways forward (stop the bridge, reuse its secret via ELF_MCP_TOKEN, or pick a free port via ELF_MCP_PORT). Regression tests added in `mcp/test/identity-collision.test.ts` exercise both paths against a live foreign bridge (no message leaks the token; both fail fast); the pre-existing contract assertion in `mcp/test/client.test.ts` ("MCP runtime reuses an authenticated bridge without taking ownership") was updated to the actionable-message contract.
Re-validation: MCP suite 115/115 including both new tests; root 236/236; batch 53/53; watch 21/21; smoke PASS with zero orphaned processes.
Same-machine-configured case (matching secret) remains graceful end-to-end (validated live in the fresh-install battery).

Note on isolation: all fresh tests used isolated HOME and ephemeral/test port; the live plugin pairing exercised the pre-existing shared bridge without touching its process. One ephemeral local settings token for the test instance was exposed in a transcript log (local-only, proper scrub in log files; the test process was stopped, invalidating it).

## 5. Platform coverage and packaging

- The current CI only runs node 20 on ubuntu-latest (drift jobs). Added in the candidate (uncommitted, reviewable): `.github/workflows/beta-platform.yml` (matrix macOS/Ubuntu/Windows × Node 20/22: prepublish build chain, root/batch/watch/mcp suites, fresh-install smoke) and `scripts/beta-fresh-smoke.mjs` (portable temp paths, isolated HOME, port 0, token scan, cleanup, no Figma dependency).
- Package → pack → smoke chain installed and built in CI: the `fresh-install` job now runs `npm ci` (root), `npm ci --prefix settings-next`, `npm run prepublishOnly` (Settings static build, brand assets, public bridge plugin build) BEFORE `npm pack`; a clean checkout now packages generated Settings/plugin assets.
- Smoke reliability hardened in `scripts/beta-fresh-smoke.mjs`: explicit readiness required from the spawned runtime (bridge-listening/pairing output captured from a detached process group; a silent timed-out child can no longer count as success), packaged Settings assets verified inside the fresh install (index.html, brand mascot, 404/_next build artifacts, public plugin code non-empty), and the spawned start process tree is reliably terminated (POSIX process-group SIGKILL, Windows taskkill /T /F) with an explicit "process group fully terminated" check and a post-run orphan audit (observed 0).
- Locally observed: macOS + Node 22 suites root 236/236, batch 53/53, watch 21/21, mcp 115/115 all pass and the smoke passes (22 checks).
- NOT actually executed anywhere: Linux and Windows runs, and Node 20 — the matrix config has not run on GitHub yet; treat all as **unverified** until it runs. A config addition is not passing coverage.
- Figma-dependent live tests are excluded from CI by design.

## 6. Remaining beta blockers
1. Version proposal pending: apply 1.0.0-beta.1 train if accepted, then repack (artifact hash changes).
2. CI matrix must actually execute (after the workflow lands) before Linux/Windows/Node-20 claims; until then keep the README/docs claim scoped to observed platforms.
3. Upstream-from-candidate known issue (excluded by design): hosted plugin-consent red test lives with the unfinished hosted work in the original workspace.
4. Live assistant/Figma pairing and writes remain live acceptance gates (production-readiness doc); not exercised here.

## 7. Proposed selective commit steps (for Codex review)

In `/Users/macintoshhd/Work/elf-beta` — exactly this file set, no `git add -A`:

```
git add src/project.ts src/components.ts src/start.ts \
        test/project.test.ts test/components.test.ts \
        src/settings.ts test/settings.test.ts \
        mcp/src/bridge.ts mcp/test/presence.test.ts \
        mcp/src/runtime.ts mcp/test/client.test.ts mcp/test/identity-collision.test.ts \
        settings-next/src/app/page.tsx settings-next/src/components/mcp-connections.tsx \
        extension/package.json \
        README.md docs/mcp-setup.md docs/production-readiness.md \
        docs/acceptance-2026-10-30.md \
        .github/workflows/beta-platform.yml scripts/beta-fresh-smoke.mjs \
        docs/local-beta-rc.md mcp/package.json
git commit -m "Local beta: drift ownership, scoped sync, MCP presence in Settings; defer hosted MCP"
```

Original workspace hygiene (already left as-is, none undone): staged+unstaged hosted changes preserved; untracked private docs preserved; no state discarded; protected processes untouched. Never publish/ship without ocular human approval; no Slack, no deploy in any step.

— Notes for revisers:
- The settings-next node_modules install step is required for fresh checkouts (root lockfile omission); optionally add that to CI as a follow-up (done in the added workflow).
- The isolated checkout does NOT include console; if Codex wants console CI parity, add it in the hosted workstream, not this release branch.

## Codex follow-up — 31 October 2026

Re-ran the isolated candidate: root tests 236/236, MCP tests 115/115, and root TypeScript checking passed. The collision tests are part of the MCP suite. No live Figma writes or Slack deliveries were performed.

The smoke runner now requires exit 1 plus the expected unconfigured-status message, verifies Settings/plugin assets, explicitly shuts down its authenticated detached bridge, and confirms TCP refusal. Its retry checks the port directly rather than treating a failed stop command as proof of shutdown. Process cleanup no longer returns success when its final PID probe still finds the child. Readiness detection includes stderr, where the bridge logger writes its shared-host message.

The first follow-up smoke run correctly cleaned up both test runtimes but failed its readiness assertion because it watched stdout only; the corrected rerun passed every smoke check, including explicit bridge shutdown, TCP refusal, and temporary-directory cleanup. Cross-platform execution remains pending GitHub CI; package publication is not authorized by these checks.
