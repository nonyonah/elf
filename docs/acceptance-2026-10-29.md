# Core acceptance — 29 October 2026

This pass uses isolated fixtures and mock Figma/Slack services. It does not
authorize or establish successful writes to the user's live Figma file.

## Results

| Check | Result |
| --- | --- |
| Shared engine / CLI / Settings / imports / drift | 205 tests passed |
| Batch parsing, dependency ordering, sync and manifest | 53 tests passed |
| Watcher, queued reconnect, interrupted sync and incremental writes | 21 tests passed on final run |
| MCP protocol, pairing, authorization and tools | 106 tests passed |
| Native extension, drafts, review and lifecycle | 58 tests passed |
| Hosted Console | 73 tests passed |
| Compiled bridge plugin through its real transport | 33 checks passed |
| Local Slack notification drill | Passed initial alert, changed alert, unchanged deduplication, failed-delivery retry and missing-config checks |
| Settings browser | Passed 320/375/420/800px containment, expanded documentation actions, RTL and 200% CSS zoom, keyboard open/Escape/focus return, and cancellation without authorization writes |
| Audited npm tarball | 158 files; Settings, public plugin, icon and MCP included; private-state/credential-file exclusion passed |
| Installation without checkout/global tsx | Local tarball installed into a clean temporary npm project |
| Installed CLI onboarding/restart | Existing startup acceptance passed against the installed executable: mock pairing, setup, monitoring and restart; no Figma mutation requests |
| Installed MCP | Handshake, 36 tools, project status and component discovery passed on an ephemeral bridge |
| Type checking | Root, batch, watcher, MCP, Console/server/client and Settings passed |
| Production builds | Both plugins and Settings passed |

The npm snapshot uses committed runtime sources from `7e8cc75`, with built
Settings/public-plugin assets. It excludes the user's uncommitted Console,
project configuration and live-example edits. It was not published. This is a
clean-project test on this Mac, not fresh-machine or cross-platform acceptance.

The browser test uses no real session credentials, rejects external network
traffic and supplies mock APIs through the editor bridge. CSS zoom exercises
layout reflow; operating-system scaling and actual browser toolbar zoom remain
separate live checks. The user also reported the dropdown worked yesterday;
today's live Figma checks are deferred because Figma is not opening.

## Corrections made during the pass

- Automated batch/component tests now copy a stable baseline rather than the
  live examples the user edits while testing. The component drift setup checks
  its baseline sync succeeded before making drift assertions. Live examples
  and user changes remain separate.
- The queued-reconnect test retains its write and retry assertions but allows
  ten seconds for real filesystem events on a busy host. Its initial three-second
  run timed out; the isolated sandbox also reported `EMFILE`. All four recovery
  tests passed outside the sandbox, followed by all 21 watcher tests.
- The compiled-plugin verification stub now implements Figma's private plugin
  data methods on the root. The production status path uses those methods;
  the outdated stub caused the initial verification failure.

These are test/verification corrections, not changes to live sync policy.

## Reproduce the Settings browser check

Build Settings first. Install `playwright-core` in a temporary tools folder,
then run, with Chrome installed:

```sh
npm install --prefix /tmp/elf-browser-tools --ignore-scripts playwright-core
NODE_PATH=/tmp/elf-browser-tools/node_modules node scripts/check-settings-browser.cjs
```

Set `ELF_CHROME_PATH` to a different Chrome executable if needed. Local-server
and filesystem-watch tests require the host permissions denied by some sandboxes.
The installed-CLI acceptance uses `ELF_TEST_INSTALLED_BIN` with
`node --import tsx --test test/start.test.ts`.

## Still requires live or release acceptance

- Real component creates/updates and documentation read-back, individual and
  automatic sync, intentional differences and deprecation deadlines in Figma.
- Real disconnect/revoke, wrong-file rejection, offline recovery, conflicting
  edits and interrupted writes while watcher and assistant clients coexist.
- Cursor, Claude Code and Codex interactive sessions; the installed MCP handshake
  establishes protocol compatibility, not each application's UX.
- Fresh-machine/platform and upgrade tests, public provider distribution,
  publishing identities, security/dependency review and release CI.

Next feature work is the read-only Markdown specification extraction/review
foundation in [the final-feature plan](markdown-design-system.md). Figma writes
must follow a concrete reviewed resource plan; no Markdown generation is claimed
implemented by these acceptance checks.

## Local MCP onboarding follow-up

Added local stdio account sign-in, explicit session target selection, pairing
code retrieval and fresh plugin-only approval. New/Untitled and existing files
use exact file keys; names need not match the source specification. Selection
never redirects configured project monitoring. Raw resource operations require
readiness and run through the shared transaction lane; changing the target or
connection interrupts subsequent operations. HTTP transport excludes these tools.

Verified 220 root tests, 106 MCP tests and 60 extension tests, plus root/MCP
TypeScript checks and production Settings/plugin/runtime builds. Fresh-project
stdio acceptance needs no configuration file and performs no live Figma writes.
OAuth callback tests cover private sessions, replay and disconnect during
exchange. Updated the plugin UI test stub for the existing Refresh button.

Packaging now explicitly lists public guides instead of including every local
file under docs. The local design-system specification must be excluded from
both npm and VSIX artifacts. Live browser consent, plugin pairing and actual
new/existing-file resource operations remain user acceptance checks. Combined
Markdown plan/apply remains the next implementation stage.
