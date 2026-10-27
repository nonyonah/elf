# Unified Elf workflow — implementation tracker

## Implemented

- One npm package includes startup, Settings, bridge, monitoring, managed sync,
  MCP, and the development Figma plugin.
- First run opens setup; configured projects resume when Figma reconnects.
- Onboarding uses the existing Settings typography, components, colors, and spacing.
- Project-relative source discovery, token-only setup, optional linked components,
  Figma pairing status, Slack connection, and an explicit Slack test message.
- Private persistent machine identity and a shared bridge host that outlives
  individual terminal and MCP connections. `elf bridge --stop` stops an unused host.
- Short-lived single-use terminal codes; hashed, revocable saved file pairings.
  Normal saved pairings have no session-age expiry. Older credentials require
  one fresh pairing to adopt the verified reconnect handshake.
- Per-file revocation from Settings; code refresh without restarting the host.
- Bridge-wide transactions and file checks before every managed request.
- A shared project sync configuration in `elf.config.json`; existing batch
  settings migrate while preserving unrelated project configuration.
- Reviewed plans expire after ten minutes and are invalidated by source, config,
  manifest, or Figma changes. Enabling automatic sync is an explicit reviewed action.
- Automatic writes pause for Figma edits, removed resources, or missing baselines.
- Confirmed write values are verified before accepting new trusted baselines;
  partial or unverifiable writes require a fresh review.
- Monitoring remains available without automatic writes.
- Full component implementation hashes detect changes outside extracted props.
  Changes without updated descriptions are reported instead of silently "synced".
- Removed/renamed code resources remain in Figma with an explicit resolution path.
- MCP project check, plan, apply, monitoring, description preparation and saving.
- Managed MCP writes update the same manifests and activity used by the watcher.
- Settings shows recent activity, sync reviews, conflicts, and assistant setup.
- Existing Settings servers are reused only after proving machine identity and
  matching the selected project.

## Security boundaries

Listeners bind to loopback. A port collision is never sufficient proof of trust.
Bridge controllers and saved plugin reconnects mutually authenticate with fresh
HMAC challenges. Reconnected messages carry directional, ordered authentication
tags to reject tampering and replay. Pairing digests are authentication secrets, stored in
private files outside projects. Rotating the machine identity changes the
pairing namespace. Project files never contain machine or plugin credentials.
Local project MCP tools are not exposed by the public HTTP adapter.

Settings validates Host and Origin, rejects cross-site browser API access,
requires an explicit header on writes, limits bodies, and returns no pairing
credentials. Output files use private atomic writes. Project paths and symlink
escapes are checked. Descriptions validate known fields and token references.
Transactions are bounded and release on controller loss. Queued expired calls
cannot later begin writing. Plugin replacement rejects in-flight requests.

Owner-only POSIX permissions protect against other machine users; code running
as the same user remains a trusted principal. Figma's API does not provide a
cross-client database transaction: verification detects changes in supported
written fields, and uncertain results invalidate baselines rather than retrying
blindly. Shared-host startup and authenticated reuse are tested independently.

## Scope of component support

Preparation produces an editable description and extracted variant metadata,
not an automatic visual reconstruction. Unsupported tokens, missing descriptions,
and implementation-only changes remain visible. Components are compared using
the plugin-exported fields and bounded tree depth; this is not pixel comparison.
Full rendering-based code-to-Figma conversion remains a separate capability.

Managed sync is the default `elf sync` and `elf watch` workflow. The original
standalone batch/watch modules remain for compatibility and tests. No resources
are automatically deleted. Initial plans can adopt existing Figma resources only
through explicit conflict review.

## Verification

Tests use temporary projects and simulated plugin data. They cover first run,
saved setup, token edits and drift, reviewed writes, stale plans, Figma conflicts,
source-only component edits, description review, legacy config migration,
persistent pairing, revocation, transaction isolation, shared-host lifetime,
credential permissions, path validation and authenticated Settings reuse.

Browser checks cover onboarding through Settings, reviewed application,
automatic token updates, conflict preservation, assistant snippets, dark mode,
and mobile width. Final saved-pairing browser checks cover authenticated
reconnects, rejection of forged messages, and refusing credentials to a spoofed
bridge. All 83 MCP tests and 33 compiled-plugin harness checks passed. Final
startup/Settings integration and socket-free authentication tests also passed.
No live Figma document or Slack workspace was modified during implementation.

Settings opens at `http://127.0.0.1:<port>` with a single-use private link that
expires after one minute. The browser exchanges its URL fragment for a session,
removes the fragment, and stores the session in sessionStorage. API requests
require that session header; cookies are not used. `elf settings` authenticates
the running server before requesting a fresh link. Bridge startup reserves both
IPv4 and IPv6 loopback addresses before displaying a pairing code. Saved pairing
credentials never appear in reconnect URLs. An older plugin session requires one
fresh pairing after this security upgrade. These protections do not isolate Elf
from processes running as your own OS user.

The bundled development plugin enables `enablePrivatePluginApi` so Figma exposes
its real file key. A missing key stops pairing setup; `draft` is never a document
identity. Sessions created with the former placeholder need one fresh pairing.
Figma limits this API to development/private plugins. The prepared public manifest
(`bridge-plugin/manifest.public.json`) instead asks for the file link and a Figma
account connection. Each plugin opening writes a fresh nonvisual shared proof;
the local bridge reads that proof through Figma's REST API before accepting the
file identity or forwarding writes. A copied file cannot inherit the original
file's verified identity. Public OAuth registration and live verification are
still required before publication; see [connection service setup](connection-service-setup.md).
Pairing credentials are stored separately for each file.

The shared host persists after a CLI terminal exits. Clients verify its secure
file-verification capability before reusing it. If an upgrade finds an older
host, stop Elf watcher/MCP clients, run `node bin/elf-tokens.js bridge --stop`
from this repository (or `elf bridge --stop` when installed), then start Elf
again. Saved file pairings remain; temporary pairing codes must be refreshed.

Settings now provides authenticated report viewing from
the fixed project report path. Linked, special, and oversized report files are
refused. Report content is escaped text. Managed-resource inspection reads the
paired file; successful new syncs record bounded before/after excerpts in private
activity history. Older activity contains summaries only. The plugin can hide its
window while remaining running; its notification can reopen the window. This does not make the plugin an independently running background service.
See [the designer walkthrough](designer-workflow.md).
