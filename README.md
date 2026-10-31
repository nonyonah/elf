# Elf

Design-system drift checks, reviewed sync, and a local Figma bridge for coding assistants.

Elf connects design tokens and managed components in your project with a Figma file. Use the npm workflow or native VS Code sidebar to monitor changes, inspect individual drift, review supported sync operations, and receive Slack notifications. Local MCP lets a desktop coding assistant work with an approved Figma document, including preparing a design system from Markdown.

## Beta quickstart

Requires Node.js 22, a local project, Figma Desktop, and Elf Bridge. macOS with Node 22 has local acceptance evidence; other platforms remain unverified.

From your project directory, after the beta is published:

```sh
npx elf-tokens@beta start
```

Complete onboarding, choose the intended Figma file, open Elf Bridge in that file, and paste the pairing code. Approve the document connection, run a check, and review proposed changes before enabling automatic sync. Keep Elf running and the plugin open.

During beta, the plugin can be imported from `dist/bridge-plugin-public/manifest.json` inside the installed npm package. Use the official Community listing once announced.

## Workflows

- **npm:** local onboarding, Settings, monitoring, reports, and reviewed sync.
- **VS Code:** native Overview, Changes, Activity, and Manage views; the extension bundles the shared runtime. Run `npx elf-tokens@beta extension` for discovery instructions.
- **Local MCP:** connect a supported desktop assistant using `npx -y elf-tokens@beta mcp --project /absolute/project/path`. Settings provides client configuration. There is no hosted MCP URL in this beta.

## What gets checked

Elf compares supported token values and project-managed components. Unrelated Figma components remain available to import without generating component drift. Tracked resources removed from code still appear for review.

Individual sync includes required dependencies. Save-triggered automatic sync scopes affected resources and retains conflict, source, connection, and post-write checks. Unsupported descriptions, unknown token references, deprecations, and conflicts can require manual review.

AI descriptions require a compatible editor language model. Generated descriptions and component imports need review. Markdown-to-Figma creation is provided through MCP and asks for missing visual/state decisions before applying approved changes.

## Documentation

- [Documentation](https://elf-docs.riftlabs.xyz)
- [Coding-assistant setup](docs/mcp-setup.md)
- [Document authorization](docs/document-authorization.md)
- [Component review](docs/component-review.md)
- [Markdown design systems](docs/markdown-design-system.md)
- [Troubleshooting](https://github.com/nonyonah/elf/blob/beta/local-rc/mintlify/troubleshooting.mdx)

## Data and permissions

Elf reads project sources and stores local manifests, reports, configuration, and drafts. The paired plugin executes approved operations in the open file. Strict Figma verification uses the hosted OAuth connection service; plugin-only mode requires explicit approval. Slack sends enabled notification content to Slack. AI context is handled by your selected provider. Do not commit local credentials, private Settings links, or webhook URLs.

## Support and development

[Report issues](https://github.com/nonyonah/elf/issues) with versions and redacted errors. [Help support this project](https://checkout.bachs.io/pay/pl_02b9f8010642).

```sh
npm ci
npm ci --prefix settings-next
npm test
npm run prepublishOnly
```

Run tests locally before release. Slack notifications do not execute release checks. npm, Marketplace, and Figma listings are separate publication steps.

## License

MIT — see [LICENSE](LICENSE).
