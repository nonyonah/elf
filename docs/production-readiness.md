# Production readiness

## Release gate update — 29 October 2026

Hosted MCP plus Elf Bridge now has a disabled local preview. Complete its
[deployment and desktop/web acceptance](hosted-mcp-deployment.md) before enabling
the public connector. This adds a new OAuth and tenant-isolation release gate;
it does not replace the existing installation and distribution checks below.

The local preview now includes prose Figma documentation separately from visual
specifications, reviewed individual sync, independent automatic-sync filtering,
token imports with collection identity, reviewed React component import drafts,
library selection (including shadcn/ui and HeroUI v3), and mascot branding.
These implementation milestones do not establish public-release readiness.
Earlier checklist entries below describe historical gaps; use actual acceptance
results rather than treating every old unchecked item as missing code.

Before calling this production-ready, record results for these remaining gates:

The [29 October acceptance record](acceptance-2026-10-29.md) supersedes the
earlier headless keyboard-focus uncertainty. The reproducible mock-browser check
passes keyboard opening, Escape/focus return, RTL, 200% CSS zoom and card-control
containment at 320/375/420/800px. Actual browser toolbar zoom, operating-system
scaling and real-provider behavior remain separate live checks. The same record
separates automated results from live checks deferred while Figma is unavailable.

1. Run the full release suites and artifact audits against the final commit;
   inspect dependencies, OAuth/IPC/credential boundaries and private-file exclusion.
2. Test npm and VSIX in a clean project without the checkout: onboarding,
   library setup, imports, AI consent/documentation, individual/automatic sync,
   reports, Slack deduplication and restart recovery. Record platform coverage.
3. Exercise wrong/revoked files, stale plans, concurrent watcher/MCP clients,
   interrupted writes/retries, intentional divergences and deprecation deadlines.
4. Verify real assistant sessions in Cursor, Claude Code and Codex. Keep direct
   MCP resource operations distinct from managed project sync and drift baselines.
5. Complete external-user Figma/Slack distribution, real extension publisher,
   version/update policy, privacy/support/recovery documentation and release CI.
   Publish only after these gates pass and release approval is given.

The Markdown-to-design-system goal is tracked in
[its implementation plan](markdown-design-system.md). The local preview includes
bounded Markdown ingestion and assistant-driven extraction review through MCP only. The extension and npm
Settings keep their existing drift/sync workflows and have no Markdown creation
controls or HTTP endpoints. Combined Figma plans/apply, presentation generation
and baseline adoption remain work. This is the final planned feature addition before
production acceptance and release hardening, not an existing importer. Its input
is the user's existing Claude-generated project `.md`; its output includes Figma
usage documentation as well as supported design-system resources.

### Figma plugin icon

Both plugin headers now use a 28px mascot. The public build also includes
`dist/bridge-plugin-public/plugin-icon.png`, copied from the exact mascot artwork.
Upload it in Figma's plugin publishing/edit-listing icon field. The enclosing
Figma title/menu icon is configured there; an HTML favicon or invented manifest
`icon` property does not configure it. Figma currently recommends a 128 × 128px
upload; export that size from the supplied artwork in the publishing workflow.
See [Figma's publishing instructions](https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community).

The npm package remains a supported product. The native extension must reach
parity for the interactive workflow, while npm retains scripts/CI and MCP retains
assistant integration. Use one engine, configuration, pairing store, review
validation, and drift rules across all interfaces.

## Discovery and parity

`npx elf-tokens extension` introduces the editor preview. First project setup
mentions this command. It does not install an extension automatically. Replace
preview instructions with the verified Marketplace link after publication;
do not advertise an unpublished extension as available there.

| Workflow | Current state | Remaining work |
| --- | --- | --- |
| Automatic discovery, monitoring, checks | Shared engine; native controls exist | Fresh-machine and multi-project lifecycle tests |
| Figma/Slack connection and pairing | Both interfaces supported | Confirm live reconnect after rate limiting; revoked/offline recovery |
| Reports, activity, resource inspection | Native read-only views and npm/browser reports | Source links and final usability checks |
| Reviewed sync and automatic sync | Shared plan/apply validation | Cross-client concurrency and reload/recovery checks |
| Component descriptions | Browser form and native diff review | Native token suggestions, source/context links, discoverable component selection |
| Intentional divergence and deprecations | Engine/config supported | Native inspect/edit/review actions; deadline and expiry acceptance tests |
| Notifications | Slack plus native activity/alerts | Confirm no duplicates after reload and across concurrent clients |
| MCP | Shared engine and automated protocol tests | Real Cursor, Claude Code, and Codex checks using the editor-bundled runtime |
| CI/webhooks/hosted console | npm/server workflows remain | Document boundaries; native setup/status where useful, without running CI in an editor |

## Blockers for the first public release

1. **Reliable connections:** confirm the live Figma reconnect after its 429 limit
   clears. Verify renewal, retry delays, wrong-file rejection, revoked access,
   persistent pairing, and disconnect without bypassing verification.
   Plugin-only document approval is now implemented as a distinct trust model:
   explicit fresh per-connection approval, no independently verified URL claim,
   and no REST calls. Existing strict projects remain strict until opt-in.
   Mock integration tests cover replay, expiry, strict-policy rejection, and
   managed sync planning. The user confirmed live plugin-only pairing and AI description generation on October 28, 2026. New individual-sync and token-import flows still need live acceptance.
2. **Interactive parity:** finish the gaps above and run the same acceptance
   scenarios through npm Settings and native controls. Avoid adding behavior to
   only one adapter when it belongs in the shared engine.
3. **Write safety and recovery:** test conflicts, stale reviews, intentional
   differences, deprecation deadlines, partial failures, rollback/retry behavior,
   and watcher/MCP coexistence. Confirm retries do not duplicate resources.
4. **Distribution readiness:** complete Figma OAuth/plugin and Slack distribution
   setup for users outside the development accounts. Confirm applicable provider
   review requirements before publishing. Choose the real extension publisher;
   `elf-local` is only the preview identity.
5. **Clean installation:** install npm and VSIX on a clean machine without this
   checkout, global tsx, or pre-existing credentials. Test supported platforms,
   trusted/untrusted workspaces, editor reloads, upgrades, and runtime compatibility.
6. **Security and releases:** review OAuth, local IPC, credential storage, path
   handling, dependency supply chain, package contents, and logging. Add extension
   tests and package audits to release CI; define version compatibility and an
   update process. Keep app secrets on the Worker. Publish only approved artifacts.
7. **Public guidance:** document onboarding, component limitations, intentional
   differences, rate limits, recovery, privacy, and support. Provide a verified
   npm → extension installation link and keep both entry points documented.

## Additional first-release scope

AI-generated component-description drafts and reviewed Figma-to-code token/
component imports are part of the agreed first-release scope.

The local AI-description preview uses editor-provided models, per-request
source-sharing consent, bounded responses, editable diffs, uncertainty notes,
and shared schema/token/source-revision validation. It needs a live model-provider
acceptance test before release; automated tests use mocks and send no source.
Discovery and draft validation are also exposed through MCP. Editor token
completion and a source/token context document are available for manual drafts.

A first token-import preview now creates a reviewed new Elf JSON file through
the bridge, preserves modes and alias source data, skips existing code names,
and rejects stale plans and overwrites. It is shared by npm Settings, MCP and
the native extension. Imported files support checks and component token references.
CSS/Tailwind conversion, reverse-write adoption, and direction choices at
connection remain. A React TSX component-import preview now confirms framework, supported declared
library, reuse, and destination choices, then opens an editable AI/manual code
draft. Shared validation rejects unsafe APIs/imports, stale contexts, and
overwrite attempts. Native, npm, and MCP adapters exist. Vue/Svelte adapters,
managed-baseline adoption, broader library/workspace detection, and live
component-code acceptance remain. The plugin can now request individual reviewed
code-to-Figma creates and updates through a registered local project. Live
plugin-panel acceptance is still pending.
Neither component import generation nor model output may overwrite project files or write
to Figma without explicit reviewed approval. Do not advertise imports as shipping.

Automated tests are evidence for the covered cases, not proof of every live
provider flow or operating system. Keep observed live results separate from
mock tests and unverified release assumptions.

See [component sync and imports](component-sync-and-imports.md) for the new native
actions, individual sync dependency rules, and token-import limitations.
