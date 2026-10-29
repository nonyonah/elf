# Hosted Elf MCP with Elf Bridge

## Agreed direction

Keep Elf Bridge as the Figma execution path. Do not make Figma's official MCP
a dependency of Elf's hosted service. Desktop and web assistants connect to
Elf; the plugin executes the supported operations in the user's open file.
This removes the IDE, repository clone, local terminal and tunnel requirements
from the hosted design-system workflow. The plugin must remain running for
Figma reads and writes; do not describe it as an unattended background service.

This is an implementation plan, not a deployed connector. There is no public
hosted Elf MCP URL to give users yet.

## Intended user flow

1. Add the hosted Elf MCP URL in a compatible assistant and sign in to Elf.
2. Supply the Figma file URL and open that file in Figma.
3. Open Elf Bridge, choose the hosted connection, and pair it using a short-lived,
   single-use code obtained through the authenticated Elf connection flow.
4. Confirm the exact file and verification mode. Pairing a plugin does not by
   itself authorize resource changes or automatic sync.
5. Share the design-system Markdown with the assistant. Review extracted tokens,
   collections, components, states and documentation, resolving missing details.
6. Approve a plan bound to that user, file, connection and source revision.
   Apply it, read back the results, and offer links to the created resources.

New and existing files are supported. Names are labels; route and authorize by
file key and connection identity. Preserve unrelated resources and original
master IDs. Interrupted writes require inspection and reconciliation before
retrying; never blindly replay an operation whose outcome is unknown.

## Current implementation and gaps

- `mcp/src/http.ts` is a local Node HTTP transport, bound to loopback. A tunnel
  exposes that process; it is not a hosted multi-user service.
- Account and target onboarding tools are currently excluded from HTTP.
- Markdown extraction currently reads bounded project files. Hosted clients need
  bounded UTF-8 Markdown content ingestion with equivalent schema validation,
  source hashing and review expiry; they cannot supply a server filesystem path.
- The plugin currently relies on the shared local bridge. Hosting MCP without
  a hosted plugin transport would still require that local process.
- The existing Elf Console Worker provides account/workspace infrastructure and
  hosted OAuth callbacks. Its local connection tokens and callbacks must not be
  treated as MCP access tokens or reused as hosted bridge credentials.

## Implementation sequence

1. Add hosted MCP authentication and routing to Elf Console: OAuth authorization
   code with PKCE, protected-resource metadata, audience-bound access tokens,
   exact redirect validation, revocation and client compatibility tests. Keep
   the existing local stdio and HTTP behavior working.
2. Introduce a connection coordinator, using Cloudflare Durable Objects or
   Agents, that isolates each authenticated owner's document connection. Bind
   every request, pairing, approval and result to the owner and connection;
   never accept a model-supplied owner ID as authority.
3. Add the plugin's hosted transport alongside local transport. Restrict it to
   the configured Elf service origin. Store a revocable credential scoped to
   that pairing, not account OAuth credentials. Show connection type, selected
   file, assistant activity and a disconnect action in the existing UI style.
4. Port bounded onboarding, resource tools and Markdown review to the hosted
   runtime. Separate Node filesystem/project tools from portable Figma schemas
   and handlers. The hosted runtime must not execute arbitrary model code,
   shell commands or filesystem paths.
5. Bind reviewed writes to exact operation hashes and expire approvals on
   relevant changes. Serialize per-document operations, bound payloads and
   queues, record operation outcomes, and require read-back before reporting
   success. Disconnect cancels pending work; uncertain writes are reconciled.
6. Prove the complete flow in one desktop client and one web client before
   documenting broader compatibility. Do not infer consumer-app support from
   a provider's API support. Publish a connector URL only after deployment and
   end-to-end acceptance.

## Security and acceptance checks

- Cross-user/file request and result isolation, including reconnect races.
- Pairing expiry, one-use consumption, attempt limits and credential revocation.
- No tokens in URLs, model-visible outputs, logs or error details.
- Plugin-only trust remains explicit; account sign-in is not independent proof
  of the currently open document. Reconnection follows the approval policy.
- Markdown is untrusted data; it cannot authorize tools, writes or networking.
- New file, existing file, ambiguous names, stale reviews, duplicate requests,
  partial apply, plugin closure and reconnect all have deterministic outcomes.
- Preview and verify the same planned operations through local and hosted paths.
- Local npm, extension, drift monitoring and Slack workflows remain functional.

Figma's official MCP call allowances do not apply to this independent Plugin API
transport. Figma plan capabilities, plugin restrictions and any REST calls made
for account/file verification remain subject to their own limits. Do not promise
unlimited usage or bypasses.
