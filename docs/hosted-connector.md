# Dedicated hosted connector

Public MCP: https://elf.riftlabs.xyz/mcp
Settings: https://elf.riftlabs.xyz/settings
Plugin download: https://elf.riftlabs.xyz/downloads/elf-bridge-hosted.zip

This is Worker `elf-mcp`, with separate D1 `elf-mcp` and OAuth KV. It does not deploy or change the existing `elf-console` OAuth service. The source config is console/wrangler.mcp.jsonc; use `npm --prefix console run build:mcp`, `npm --prefix console run typecheck:mcp`, and explicit `deploy:mcp` after review. The build needs Python 3 for the allowlisted plugin ZIP. Regenerate bindings with Wrangler after config changes.

Security: accountless browser authorization with PKCE S256 and provider browser-binding cookie, explicit file-scoped plugin approval, opaque credentials stored as hashes, tenant-scoped operations, separately browser-approved write plans, generation/snapshot checks, bounded payloads/queues and expiry cleanup. Hosted plugin trust is not independent Figma REST verification. No source filesystem or shell is exposed remotely.

The old consent failure was caused by Hono replacing the OAuth anti-CSRF Set-Cookie when c.res was mutated while returning a new response. Both cookies now live on the returned response; regression coverage asserts both plus the plugin approval records.

The blank approval page came from bundling React 18 from shared Settings components alongside the React 19 renderer. Both Vite configurations now deduplicate React and React DOM. Headless Chrome verified the public Settings content and the authorization form render. The MCP initialize response includes the mascot icon, also served as the Settings favicon at /elf-logo.png. Display in an assistant depends on client support.

Validation: 91 Console/hosted tests, 19 plugin UI tests, 39 compiled-plugin checks, server and isolated Settings typechecks, Settings build and deployment dry-run passed. Live protocol checks through a real MCP SDK passed metadata, PKCE/browser binding, explicit approval, scoped read round trip with a simulated plugin, refusal of unapproved writes, and revocation. No real Figma resources were changed in that protocol check. The live result file is /tmp/elf-hosted-live-smoke.json. Real assistant/Figma pairing remains a separate user check.

The hosted tools are core Figma reads, queued results, design-system source preparation/validation, and reviewed write wrappers. Local project discovery, filesystem, watchers, and editor-only flows remain local. Client support depends on Streamable HTTP and OAuth; no universal provider compatibility is claimed.

Multi-file approvals: migration 0009 preserves existing consent rows and changes their key to (owner, connectionId). Accountless `get_figma_pairing_code` returns an existing approved connection or a browser Add file link. The latter is an unprivileged request: the matching browser session must create a pairing, then a separate plugin credential must approve that exact generation. A browser must still have an assistant grant before adding a file. The Settings file list supports independent disconnect; no active-file global state or retargeting is used. Figma OAuth is not required by this Worker; optional local REST verification remains separate.

Multi-file verification: 91 hosted/Console tests passed, with the final accountless regression rerun after the switch-back and browser-owner checks; 20 plugin UI tests passed. The deployed two-file protocol check passed using simulated plugins, including unchanged original plan target/approval state and independent removal. Chrome rendered the deployed Add file form. No real Figma files were accessed or changed. Result: /tmp/elf-multifile-live-smoke.json.
