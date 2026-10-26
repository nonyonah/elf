# Using Elf

## Start your session

From your project folder, run `elf start` after installing the package. This
starts monitoring and opens the local Settings page. During development in this
repository, use `node bin/elf-tokens.js start`. The updated npm package must be
published before `npx elf-tokens` can fetch this version from the registry.

Open the intended Figma file and launch Elf Bridge. After its first pairing,
the plugin reconnects with its saved credential. Keep this terminal and Figma
file open. A saved pairing does not automatically launch a closed plugin.

On first setup, choose your token file and optionally your component folder.
Connect Slack if you want alerts. Setup starts in monitoring mode. To write to
Figma, choose **Review sync**, inspect the plan, then **Apply sync**. Enable
**Automatic sync** through the reviewed plan when you want saves to push supported
changes. Figma edits and removed resources pause automatic writes for review.

## Keep the plugin out of the way

After connecting, select **Hide window** in Elf Bridge. The iframe and connection
stay alive while that plugin remains running. Use **Show plugin** in Elf Settings,
or the notification's **Show Elf Bridge** button, to restore the window.

Figma does not support independently running background plugins. Closing the
plugin, closing its file, or starting another plugin can end this connection.
Reopen Elf Bridge to resume. Saved pairing normally avoids entering another code.

Official references:
- https://developers.figma.com/docs/plugins/api/figma-ui/
- https://help.figma.com/hc/en-us/articles/360042532714-Use-plugins-in-files

## See what happened

A successful sync and a clean drift report are separate outcomes. Sync writes
only supported, reviewed resources. Drift checks can include other resources
already present in the Figma file. Remaining drift does not mean the sync failed.

In Settings:

- **Synced resources → View synced resources** reads managed resources from the
  paired file. Variables show their collection, current values, and whether they
  match the last verified sync. Components show their last recorded sync status
  and an **Open Figma** link to their canvas node. Styles show current values.
- **Notifications (the bell at the top right) → View … synced changes** shows before/after values from new
  syncs. Older syncs did not retain those values; inspect their current managed
  resources instead. Before/after excerpts and recent history are bounded.
- **Drift report → View report** opens the latest Markdown report in the browser.
  **Download .md** saves that same report. **Check now** requests a fresh check;
  wait for it to finish before reopening the report. Reports require the private
  Settings session and are shown as escaped text rather than executable HTML.

In Figma, synced tokens appear in the local **Variables** panel, often in the
**Primitives** collection. They are variables, so syncing them does not create
visible canvas swatches. Managed components appear on the canvas. Automatic
visual reconstruction from arbitrary component source is not supported; component
creation uses reviewed `.figma.json` descriptions and supported variants.

## Change code

Edit a supported token and save. With automatic sync enabled and Elf Bridge
connected, Elf pushes the change, verifies the written value, and checks drift.
Open Settings to inspect the result. New activity appears in the notifications bell. If sync pauses, review the listed conflicts
before choosing whether to preserve the Figma edits or explicitly replace them.

Coding assistants use the same bridge and project configuration. Settings has
setup snippets for Cursor, Claude Code, and Codex. Ask the assistant to check
drift, prepare a component description, or show a sync plan before applying it.

If Settings says the page is newer than the running server, stop the existing Elf
terminal with Ctrl+C and start Elf again before refreshing the browser. Refreshing
alone cannot update a running Node process. New startup attempts refuse to silently
reuse incompatible servers. Report and action failures show instructions rather
than JSON parser errors. A requested check runs asynchronously; the confirmation
message tells you to wait for the project status before reopening its report.
