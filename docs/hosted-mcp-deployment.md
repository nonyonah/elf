# Hosted MCP preview: deployment and acceptance

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

## Deploy a reviewed preview

1. Inspect the complete deployment diff. Do not inadvertently publish unrelated
   working-tree Console UI changes. Keep the hosted flag false initially.
2. In `console`, provision an OAuth KV namespace with
   `npx wrangler kv namespace create OAUTH_KV`. Put the returned ID on the
   `OAUTH_KV` binding in `wrangler.jsonc`. No new OAuth client secrets are needed
   for Elf to issue its own connector tokens; Clerk remains the sign-in provider.
3. Apply `0006_hosted_mcp.sql` using the existing D1 migration workflow. Use
   local migrations first, then the reviewed remote migration. Existing tables
   and existing project drift targets are unchanged.
4. Verify Clerk sign-in on the deployed origin and that the Vite client has its
   matching publishable key. The checked-in Clerk key is a test key; production
   identity/distribution must be configured before a public launch. Never commit
   Clerk secret keys or local `.dev.vars`.
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

In a supported desktop assistant, add the connector URL, sign in and explicitly
approve the requesting client, redirect host and scopes. Repeat in one web
assistant. Use accounts/files intended for testing.

1. Ask `figma_onboarding_status`, then `get_figma_pairing_code` with the file URL.
2. Open that file in Figma and Elf Bridge. Select Hosted Elf. Choose explicit
   plugin-only document authorization, enter the code and keep the plugin open.
3. Follow the connection link from the assistant, verify the file key and trust
   mode, and approve the current connection in the browser. Reopening the plugin
   uses the saved credential but requires fresh document approval.
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
