# Elf editor extension (development preview)

This version runs the existing Elf engine from VS Code and presents it in the
native **Elf** activity-bar view. It does not load the Settings page in a
webview. Daily work is separated into **Overview**, **Changes**, and **Activity**.
Use the gear in Overview for **Manage**: account connections, pairing, Slack,
notification preferences, automatic sync, and MCP setup.

AI-generated descriptions are available as a development preview through editor
language models. Slack/Figma authorization opens
your browser; return to VS Code and the native view refreshes connection status.

For plugin-only use without REST verification, select **Approve open document in
Elf (no REST)** in the plugin, then **Manage → Approve open Figma document** in
Elf. Each connection requires fresh confirmation; saved pairing is retained.
Strict mode remains optional and existing strict projects are not downgraded.
See [document authorization](https://github.com/nonyonah/elf/blob/main/docs/document-authorization.md) for the security
model, upgrade steps, and draft recovery after an editor reload.

To use a prepared local `.vsix` in your current workspace, open the Extensions
view, choose **… → Install from VSIX…**, and select the Elf package. Then open
the Elf icon in the activity bar. No development window is needed. This local
preview is not a Marketplace publication.

Build Settings and the public bridge plugin from the repository root, then run
`npm --prefix extension run prepare-runtime`. This bundles the local package and
its dependencies; users will not install a runtime from their project. Do not
distribute a build without first running the core tests and package audit.

Launch an Extension Development Host with VS Code's `--extensionDevelopmentPath`
pointing to this directory, or open this `extension` folder in VS Code and press
F5 using the included launch configuration. Open a trusted local project folder
in the new window and use the Elf activity-bar view:

- **Start** to start the bundled monitor without a terminal.
- **Overview** shows the selected project, monitoring state, paired file, and
  drift summary. Use its title actions to check or refresh.
  Expand a drift category to inspect individual resources; an item opens only
  its own values. Category summaries, reports, and activity details use read-only
  native documents and do not need saving.
- **Changes** reviews planned writes and issues, applies the reviewed plan, and
  lists synced resources. The apply/cancel title actions appear during review.
- **Activity** contains recent results and before/after changes. Its title action
  marks notifications as read or clears them. New results also appear as native
  VS Code notifications; repeated identical checks are suppressed.
  Checks compare resource fingerprints, so different drift can still notify
  when the total count is unchanged.
- **Manage** (the Overview gear) connects/disconnects Slack and Figma, generates
  pairing codes, changes alert preferences, enables reviewed automatic sync, and
  opens coding-assistant setup. Advanced description actions also live here.
  Choose **Generate component description with AI** to select a discovered
  component, inspect the exact source/token context, choose an available editor
  model, and consent before sharing it. Elf opens a validated editable draft and
  separate assumptions/unsupported-detail notes. Generation does not save a
  project description or write to Figma. Manual preparation remains available.
  If no model is available, configure an editor model provider or use MCP/manual
  review; Elf does not install providers or ask for API keys itself.
- **Elf: View Drift Report** opens Markdown as a native text document. Component
  descriptions use an editable native diff; reviewed saves still use the engine's
  validation and stale-review protection.
- **Stop** to stop this extension's monitor. Shared bridge connections may
  continue serving other clients.

One project runs per editor window. Start is explicit; editor reload stops the
owned runtime. A missing runtime produces an error, never a fallback to project
scripts or an automatic network install. Secrets and runtime output are not
written to editor logs. Private Settings links and pairing codes stay in memory.
The extension authenticates through a fresh single-use link over the private
process channel. Session credentials stay in the extension host. OAuth addresses
must come from the local connection service before being opened externally.
The Figma plugin must remain running for live Figma operations.

Description drafts offer project token completion inside JSON string values.
Use **Elf: Description Source and Token Context** to inspect source, variants,
tokens, and AI review notes. Saving still requires explicit review and rejects
stale source, unknown references, invalid schemas, and mismatched projects.
Figma-to-code token and component imports remain upcoming work.
Verification respects Figma rate limits. Reconnecting an account does not bypass
those limits. Older shared bridges without renewal support must be stopped
after their clients close; saved pairings survive the replacement.

### Component sync and token imports

Use **Save and Review Component Sync** on a description diff or its row in Changes.
**Project components** suggests descriptions where needed and offers individual
reviews. Planned resources can also be reviewed individually. Required dependencies
are listed before applying. **Manage → Import Figma tokens** previews a new JSON
file with modes and alias source data; it never overwrites existing code.
See the [workflow and limitations](https://github.com/nonyonah/elf/blob/main/docs/component-sync-and-imports.md).

### Component code import preview

**Manage → Import Figma component** confirms React TSX, a supported declared library
or native elements, selected local reuse, and a new destination. AI/manual drafts
open in a diff; **Create Reviewed Component** applies only reviewed code. It does
not install dependencies or adopt a managed Figma baseline. React is the first
output adapter. See the [component import and plugin export guide](https://github.com/nonyonah/elf/blob/main/docs/component-sync-and-imports.md).
