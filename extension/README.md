# Elf — design-system drift and sync

Keep your project and Figma design system connected from a native editor sidebar. Elf helps you inspect drift, review supported changes, and monitor your design system while you work.

## Beta requirements

- VS Code 1.95 or later and a trusted local workspace.
- Node.js 22 available to the extension runtime.
- Figma Desktop with Elf Bridge open in the intended file.

macOS with Node 22 has local acceptance evidence. Windows/Linux support remains unverified. This extension is a beta; review changes before applying them.

## Get started

1. Install [Elf from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=NonsoOnah.elf-design-system) and choose the pre-release version. The extension ID is **NonsoOnah.elf-design-system**. You can also install a maintainer-provided VSIX with **Extensions → … → Install from VSIX**.
2. Open your project and select the Elf activity-bar icon.
3. Choose **Start** and complete project setup.
4. In **Figma Desktop**, import Elf Bridge’s development `manifest.json` using **Plugins → Development → Import plugin from manifest**. See [plugin installation](https://elf-docs.riftlabs.xyz/pairing).
5. Run Elf Bridge, paste the pairing code, and approve the intended document connection.
6. Run a check and inspect the changes before enabling automatic sync.

Keep Elf Bridge open: saved pairing does not make a closed Figma plugin run in the background.

## Cursor and compatible editors

In Cursor or another compatible VS Code-based desktop editor, install the official Elf VSIX with **Extensions → … → Install from VSIX**, reload if prompted, then open Elf in a trusted local project. The Microsoft Marketplace listing does not mean Elf is available in every editor’s registry. Verify the publisher when using another registry.

The editor must support the VS Code APIs required by this extension (declared minimum 1.95). AI features additionally require compatible editor language-model APIs. Cursor and other forks have not received the same live acceptance testing as VS Code; report compatibility issues with your editor/version. See [editor setup](https://elf-docs.riftlabs.xyz/vscode).

## What you can do

- **Overview:** inspect project, bridge, and monitoring status.
- **Changes:** inspect individual token/component drift and review supported sync changes.
- **Activity:** see recent checks and sync outcomes.
- **Manage:** connect/disconnect Figma and Slack, configure notifications, pair the plugin, and manage automatic sync.
- Prepare AI-generated component descriptions using a compatible editor language model, then review and save them. Model availability and provider policies apply.
- Review supported imports from Figma and choose component implementation targets. Generated code requires review.

Elf tracks project-managed components so unrelated Figma components do not create drift noise. Conflicts, missing descriptions, unresolved token bindings, and deprecations may require review; automatic sync does not bypass them.

## npm and coding assistants

The extension bundles the shared runtime. You can also use the npm beta independently:

```sh
npx elf-tokens@beta start
```

Local MCP connects supported desktop coding assistants to the paired file. Markdown-to-Figma design-system creation is an MCP workflow. There is no hosted MCP URL in this beta.

## Permissions and data

Elf reads design-system sources in the selected project and maintains local configuration, manifests, reports, and drafts. The plugin performs requested operations in the approved Figma document. Strict account verification uses the hosted Figma OAuth connection service; plugin-only approval requires explicit trust of the current document. Slack notifications send notification content to Slack. AI context is handled by your selected editor/assistant provider.

Do not share pairing credentials, Settings session links, webhook URLs, or private design files in public issues.

## Documentation and support

- [Documentation](https://elf-docs.riftlabs.xyz)
- [Report a bug](https://github.com/nonyonah/elf/issues) — include versions and redacted errors.
- [Security and document authorization](https://github.com/nonyonah/elf/blob/beta/local-rc/docs/document-authorization.md)
- [Help support this project](https://checkout.bachs.io/pay/pl_02b9f8010642)

## Development

Build the root package assets before packaging the extension. `npm --prefix extension run prepare-runtime` bundles the checkout runtime; `vscode:prepublish` also runs extension tests. The development host and local VSIX flow do not imply a Marketplace publication.

## License

MIT. See [LICENSE](LICENSE).
