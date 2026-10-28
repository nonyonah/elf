# Authorize the open Figma document

Elf supports two explicit authorization modes. Existing project connections stay
strict until the user chooses plugin approval; there is no automatic downgrade
when Figma returns an error or rate limit.

## Plugin-only approval (no REST)

1. Open the intended file and the updated Elf Bridge plugin.
2. In **Change file link**, paste its link and select **Approve open document in
   Elf (no REST)**. For a new link, this is the default choice.
3. Connect using the saved pairing or a terminal/editor pairing code.
4. In the native extension choose **Manage → Approve open Figma document**.
   In npm's `elf start` Settings, use **Approve open document without REST**.
5. Check the document name, project, and routing key in the confirmation before
   approving. Then review a fresh sync plan before applying changes.

The link selects a project; Elf does not claim that it independently verified
the official URL. Approval applies only to the current authenticated plugin
connection. Reopening or reconnecting requires fresh approval. A copied document
does not inherit approval, even if it copies stored identifiers and pairing data.
Saved pairing credentials authenticate the bridge connection, not document identity.

Approval pauses automatic sync and forces project checks through the bridge.
Tokens, components, drift checks, Slack, AI drafts, and MCP retain their existing
engines and validation. Figma must remain open with the plugin running for live
file operations. No REST identity request is made in this mode. This does not
remove Figma's own editor/Plugin API feature limits.

## Strict URL verification

Choose **Manage → Figma authorization mode → Strict URL verification** or
**Require strict verification** in Settings. In the plugin, select strict
verification and reconnect. This requires account access and reads the fresh
proof marker through REST, subject to Figma quotas. Native/private-plugin file
identity remains supported where Figma exposes it.

Strict projects reject plugin-only authorizations, including when another client
approved that same routing key. Switching back to strict closes an active
plugin-only connection. Changing modes or document authorization invalidates old
sync plans; conflicts and stale-review checks still apply.

## Upgrade from an older bridge

Save edits in any open description draft before reloading VS Code. Close Elf MCP
clients, reload the editor, then run **Elf: Restart Shared Bridge**. This stops
the owned monitor and only stops the shared bridge if no other clients use it.
Saved pairings are retained. Close/reopen the Figma plugin to load its updated
code; development imports can use `dist/bridge-plugin-public/manifest.json`.

If a description draft predates the reload, select its right-hand editor and run
**Elf: Recover Open Description Draft**. Choose its component and review the new
diff. Recovery validates against the current source and does not restore old
approval or AI notes, save the project description, or write to Figma.

MCP exposes `pending_document_approval`, `approve_plugin_document`, and
`require_strict_file_verification`. Assistants must present the exact pending
document and obtain explicit human approval; they must never approve automatically.
