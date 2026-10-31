# Hosted MCP preview: deployment and acceptance

> Deferred as of 30 October 2026. The release path is local npm MCP plus
> Elf Bridge. Hosted authorization is unfinished and has not passed acceptance.
> Keep the hosted service disabled; instructions below are development notes,
> not public installation guidance.


## Current status

Implemented locally, disabled by default. Worker and client builds, automated
OAuth/tenant/replay tests and compiled-plugin checks are separate from live
acceptance. No claim of Claude/Grok/OpenCode/Codex compatibility is made until
the actual client completes the flow. No production release is authorized by a
successful build alone.

The intended connector address, **after deployment and enabling**, is:

`https://elf-console.nonyonah.workers.dev/mcp`

This is an OAuth connector URL; do not append tokens or choose an authless
connection. Clients must support Streamable HTTP, OAuth authorization-code flow
with PKCE S256 and dynamic client registration. Client metadata document lookup
is disabled in this preview. A consumer website's MCP support must be checked
separately from its provider's API support.

Authorization and resource-review links open the standalone `/settings` page,
using the same stylesheet and controls as local Elf Settings. The Console
dashboard is not part of this connection flow. Hosted Settings lists authorized
MCP assistants, their most recent authenticated activity and Disconnect controls.
Disconnect revokes the selected OAuth grant and cancels its client's queued work;
in-flight work is marked uncertain rather than replayed. Local npm Settings
separately shows initialized local MCP sessions through the shared bridge.

## Deploy a reviewed preview

1. Inspect the complete deployment diff. Do not inadvertently publish unrelated
   working-tree Console UI changes. Keep the hosted flag false initially.
2. In `console`, provision an OAuth KV namespace with
   `npx wrangler kv namespace create OAUTH_KV`. Put the returned ID on the
   `OAUTH_KV` binding in `wrangler.jsonc`. No new OAuth client secrets are needed
   for Elf to issue its own connector tokens. Hosted MCP uses plugin approval, without an Elf account. Console retains its own Clerk sign-in.
3. Apply migrations through `0008_hosted_plugin_authorization.sql` using the existing D1 migration workflow. Use
   local migrations first, then the reviewed remote migration. Existing tables
   and existing project drift targets are unchanged.
4. Verify Settings uses plugin authorization without a Clerk prompt. Browser
   authority uses a Secure, HttpOnly, SameSite=Strict cookie, stored hashed in D1.
   It never authorizes Console account APIs. No browser credential goes to MCP.
5. Run typechecks, Console tests, local Markdown tests, plugin verification, client
   build and `npx wrangler deploy --dry-run`. Audit dependencies and artifacts.
6. Deploy the reviewed Worker/client bundle, then explicitly enable
   `HOSTED_MCP_ENABLED=true` for the preview. Ensure the configured origin matches
   the deployed origin. OAuth discovery, `/mcp`, `/authorize` and `/oauth/*` must
   run through the Worker, rather than the SPA asset fallback.
7. Build/reimport the updated Elf Bridge manifest. Both manifests allow only the
   fixed hosted service origin in addition to their existing local/tunnel paths.
   Do not broaden them to arbitrary remote origins.

## Live acceptance

### Local preview through ngrok

This path uses local D1 and KV only; it does not enable the deployed Worker.
Build the Console client and bridge plugin first. The isolated hosted preview
does not need Clerk credentials; Console account APIs remain signed out.

1. Run `ngrok http http://127.0.0.1:8790 --inspect=false`. Note its HTTPS origin.
   Request inspection must remain disabled because OAuth and plugin traffic
   contains private data.
2. From the repository root, run
   `node scripts/prepare-hosted-preview.mjs https://YOUR-HOST.ngrok-free.app`.
   It creates a git-ignored private config under `.elf/hosted-preview`, disables
   the fake-user bypass and builds a plugin allowing only that exact origin.
3. From `console`, run
   `npx wrangler d1 migrations apply elf-hosted-preview --local --config ../.elf/hosted-preview/wrangler.json --persist-to ../.elf/hosted-preview/state`.
4. From `console`, run
   `npx wrangler dev --local --config ../.elf/hosted-preview/wrangler.json --persist-to ../.elf/hosted-preview/state --ip 127.0.0.1 --port 8790 --log-level error --show-interactive-dev-session=false`.
5. Import `dist/bridge-plugin-hosted-preview/manifest.json` in Figma. Select
   Hosted Elf and explicit plugin-only authorization. The ordinary public
   manifest does not allow the ngrok preview origin.
6. Add `https://YOUR-HOST.ngrok-free.app/mcp` in Claude's custom connectors.
   Choose the connector authorization option (Claude may label it “Sign in”) and **Register automatically** if asked for OAuth client
   identification. This preview does not support the published-identity/CIMD
   option. Enable the connector in the test conversation.

Both ngrok and Wrangler must stay running. If the tunnel origin changes,
regenerate the private config/plugin and reconnect the assistant. Never place
the generated `.dev.vars`, local databases or OAuth state in source control.

### Desktop and web checks

In a supported desktop assistant, add the connector URL and authorize. Repeat
in one web assistant. No Elf account is required.

1. Settings opens with a Figma file URL field. Paste the intended file URL.
2. Open that file in Figma and Elf Bridge. Select Hosted Elf and explicit
   plugin-only document authorization. Paste the single-use Settings code.
3. In Elf Bridge, check the requesting assistant (self-declared name), callback
   host and exact file key, then approve. Back in Settings, finish the connection.
   Reopening the plugin requires fresh approval in the plugin. A different file
   requires a separate assistant authorization. Use the same browser for Settings
   and plan reviews; clearing its cookie requires reconnecting. This preview
   manages the most recently connected file in that browser; it has no account
   recovery or cross-device browser session recovery.
4. Call resource read tools with `connectionId`. Poll `get_operation_result` for
   actual results; a queued job is not a completed read.
5. Share a small Markdown design system using `prepare_design_system({markdown})`.
   Review extraction with `validate_design_system`, resolve questions and inspect
   existing Figma resources. This does not automatically adopt a drift baseline.
6. Call `prepare_figma_changes` with explicit resource operations and optional
   `sourceReviewId`. Inspect all values and existing-resource updates on its
   review page and approve the exact plan. Then call `apply_figma_changes`.
7. Poll every job, inspect partial failures, and independently read back created
   variables, components and state variants before reporting success.
8. Change the page after review; the plugin must refuse the stale write. Close
   it during execution; uncertain outcomes must not automatically replay.
9. Test two users, wrong files, expired/reused codes, revoked credentials,
   reconnects, duplicate apply and a failed operation before dependent operations.
10. Disconnect in the plugin and in the browser. Confirm that stored access is
    revoked, and that local npm/extension/MCP drift and Slack flows still work.

## Production gates after acceptance

Freeze features. Complete the existing [production checklist](production-readiness.md):
external-user Figma/Slack app availability, Figma plugin publication, real VS Code
publisher and npm release artifacts, fresh-project installation, privacy/retention
and recovery documentation, quotas/cost measurements, security review and rollback
drill. Run the release checks against the exact final commit and publish only
after release approval. Hosted MCP adds a new trust boundary and is not itself
evidence that the product is production-ready.
