# Coding assistants

For drift monitoring, complete local project setup with `elf` first. Keep the Figma plugin open.
Settings → Coding assistants provides configuration for the installed Elf
launcher and selected project. Those snippets contain no credentials. Restart
or reconnect the assistant's MCP server after initial setup.

For a published version of the package, equivalent launch commands are:

```bash
codex mcp add elf -- npx -y elf-tokens mcp --project /absolute/project/path
claude mcp add --transport stdio --scope local elf -- npx -y elf-tokens mcp --project /absolute/project/path
```

Cursor uses `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "elf": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "elf-tokens", "mcp", "--project", "/absolute/project/path"]
    }
  }
}
```

The Settings snippets use the currently installed launcher so local/unreleased
changes do not accidentally invoke an older npm release. Pin a reviewed package
version in managed environments. Project selection is fixed at launch; tool
arguments cannot select arbitrary directories.

## Connect a new or existing Figma file

The connected Figma plugin shows an **MCP** status row. It reports initialized
assistant sessions separately from the bridge and file approval, updates as
clients connect/disconnect, and shows a client count when multiple sessions are
active. Watchers and ordinary CLI controllers do not count as MCP sessions.
This status does not grant permission to modify the document. If it says
**Restart bridge to enable**, close Elf/MCP clients before restarting the shared
bridge, then reopen the updated plugin and reconnect MCP.

Local stdio MCP can also start in an existing project directory without an
`elf.config.json`. Use `figma_onboarding_status`, `connect_figma_account`, then
`select_figma_file` with the user-provided URL, new/existing purpose and explicit
strict/plugin mode. Open the selected file and Elf Bridge; request a code with
`get_figma_pairing_code` if a saved pairing does not reconnect. Plugin-only mode
requires `inspect_figma_target_approval` and explicit human confirmation before
`approve_figma_target`. Check readiness before reading or changing resources.

File names need not match Markdown or design-system names. The exact file key
and approved connection identify the target. Selection lasts for this MCP session
and does not redirect configured drift checks or managed sync. Account tokens
remain private; browser consent happens outside the assistant. These tools are
not exposed over HTTP. See [the full workflow](markdown-design-system.md).

## Recommended agent workflow

1. `project_status` and `check_drift`: inspect the project and current differences.
2. `prepare_component`: inspect parsed variants and an editable description.
3. Review layout, content, token bindings, and unsupported behavior with the user.
4. `save_component_description`: validate and save the reviewed description.
5. `plan_sync`: show creates, updates, conflicts, retained removals, and limitations.
6. `apply_sync`: apply that plan. Set `enableAuto` or `overwriteConflicts` only
   when the user explicitly requested the corresponding behavior.

Descriptions do not reconstruct arbitrary browser-rendered components. Existing
MCP variable/component/style tools remain available; raw Figma edits become
changes that managed sync must review. Managed project tools share the bridge
transaction lane, manifest, and activity log used by Settings and automatic sync.
Local project tools are intentionally omitted from the public HTTP transport.

Verified against the installed Codex CLI and official documentation:
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp),
[Claude Code MCP](https://code.claude.com/docs/en/mcp),
[Cursor MCP](https://prod.cursor.com/docs/mcp).
