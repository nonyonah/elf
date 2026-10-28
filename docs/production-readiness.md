# Production readiness

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
connection remain. Component imports must ask for
framework/library choices and identify unsupported behavior/accessibility.
Neither component import generation nor model output may overwrite project files or write
to Figma without explicit reviewed approval. Do not advertise imports as shipping.

Automated tests are evidence for the covered cases, not proof of every live
provider flow or operating system. Keep observed live results separate from
mock tests and unverified release assumptions.

See [component sync and imports](component-sync-and-imports.md) for the new native
actions, individual sync dependency rules, and token-import limitations.
