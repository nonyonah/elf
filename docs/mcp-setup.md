# Coding assistants

Complete local project setup with `elf` first. Keep the Figma plugin open.
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
