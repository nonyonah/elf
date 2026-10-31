# Local npm MCP acceptance — 30 October 2026

## Candidate and scope

Tested the working-tree candidate, not a published npm release or final commit.
The artifact is `elf-tokens-1.0.0.tgz`, containing 166 entries, with integrity:

```
sha512-JY56v2b3IfbEiXPSsNZHiLiE3SNVsad90MCwgqrEIXQXjGkGnQdSGsB9tiCW7VEXEoXUjm5y1ZzHi9g5Xyn1pQ==
```

Host: macOS, Node v22.23.0. This does not establish Node 20, Windows or Linux
compatibility. Hosted MCP is deferred; no Worker was deployed or enabled.

## Observed passes

- `npm run prepublishOnly`: root, MCP and Settings typechecks, static Settings
  build and public bridge-plugin build passed.
- `npm run mcp:test`: 111 tests passed, zero failures after removing the deferred
  hosted endpoint from normal plugin network permissions. The normal plugin
  connection selector no longer advertises hosted MCP. The explicit development
  preview helper can still add its own hosted option and exact origin.
- Packed using `npm pack --ignore-scripts` after the build. Audited the inventory
  for credentials, `.env`, `.dev.vars`, `.elf`, project configuration, private
  Rift Labs documents, description drafts and hosted-preview output; none found.
  Confirmed the launcher, MCP entry point, Settings HTML and public plugin exist.
- Installed the tarball with production runtime dependencies into a new temporary
  npm project outside the checkout, without an extension or global `tsx`.
- Launched the installed CLI through a real SDK stdio client with an empty
  workspace, a minimal PATH, isolated random bridge secret, ephemeral loopback
  port and nonexistent Figma-account path. No existing bridge was used.
- MCP initialization and tool discovery succeeded: 44 tools, including local
  onboarding, Markdown preparation and project drift tools.
- Onboarding reported no selected file, no account and not ready. A non-Figma
  URL was rejected. Explicit plugin-only target selection and pairing-code
  issuance succeeded. The stdio client and owned bridge closed cleanly.

No Figma write, account connection or live plugin pairing was performed by this
smoke test. The synthetic target key was used only to exercise local onboarding.
No package was published.

## Remaining live acceptance

1. Configure a real desktop assistant with the installed candidate launcher,
   open the public plugin in a test file and pair/approve that exact target.
2. Inspect resources, restart the assistant and plugin, and verify recovery,
   wrong-file rejection and revocation without redirecting project monitoring.
3. Prepare a small Markdown design system, review and apply supported variables,
   collections, components, states and documentation, then independently read
   back results. Repeat an update without duplicating existing masters.
4. Complete npm/extension project drift, sync, Slack, divergence, deprecation and
   interrupted-write scenarios from the production checklist.
5. Audit final dependencies, package/VSIX contents and distribution configuration
   against the actual release commit. Rebuild artifacts after any further change.

## Shared-bridge connection probe

The installed candidate also reached the existing development bridge after its
explicit credential was passed privately from the local development environment.
A default machine credential was correctly rejected by that differently
configured bridge. This probe is distinct from the standalone clean-install test;
it does not prove a fresh machine has existing pairings. The candidate found
Untitled (`eu8zGUOsrdyXXQqvJeyl1E`) awaiting explicit plugin-only approval.
Resource inspection and design changes remain pending human authorization.

### Expired live approval ticket

After the user approved inspection of the exact file, the installed candidate
submitted its selected target and the inspected pending ticket. The bridge
rejected it with “Pending document changed or expired. Inspect it and review
again.” The plugin had retained an expired pending connection. No resource
reads or writes ran. Live acceptance is waiting for the user to reopen the
plugin and authorize its fresh connection; the expiry check was not bypassed.

### Fresh live connection and reads passed

The user reopened the plugin and explicitly approved the fresh connection for
inspection. Through the installed candidate, approval succeeded and onboarding
reported ready with the correct file key and plugin-only authorization. Resource
reads succeeded: 3 collections, 28 variables and 23 top-level component resources
(16 sets, 7 standalone components). Project monitoring was not reconfigured.
The candidate also prepared the local acceptance Markdown through
`prepare_design_system`, returning bounded source, hash and extraction review.
No design resources were changed. The proposed writes are recorded in
[the live review](local-mcp-live-review.md) and await separate user approval.

### Approved sample writes and read-back

The user explicitly approved the isolated acceptance sample and repeat upsert.
The installed candidate created two Elf Acceptance collections (Default mode),
three variables and Elf Acceptance Button with four State variants. Independent
resource reads confirmed variable values, documentation, 120 × 40 variants,
8px surface corners, 16/8px padding and variable-bound purple/white paints.
The sample is at canvas position (0, 20000), set ID `7:1506`.

Read-back found a default white component background under the owned surface;
the sample payload was corrected to a transparent root with 8px corners before
repeating the final payload. Repeated collection creation and variable upserts
retained their IDs with zero additional variables created. Repeated final set
upsert returned created=false and preserved all four variant IDs and the set ID.
The file has five collections and 24 top-level resources. All 23 original
top-level component names, IDs and codeKeys were preserved; exactly one sample
set exists. This identity check does not claim a byte-for-byte audit of every
original child property. Owned sample visual child layers are replaced on update.

Verification limit: get_node exposes paint opacity but not scene-node opacity.
The requested layer opacities were supplied to the renderer but cannot yet be
independently confirmed through that read tool. Add node-opacity read-back and
its regression coverage before marking state styling fully verified. No
prototype transitions or variable-bound height were claimed. No test resources
were deleted and no project drift baseline was adopted.

See [the read-back receipt](local-mcp-live-receipt.json). Remaining live gates:
assistant/plugin restart recovery, wrong-file/revocation, npm/extension drift
and sync, Slack deduplication, divergence/deprecation and interrupted writes.

## Opacity read-back hardening

`get_node` now exposes scene-node `opacity` independently of each fill's opacity.
The transport type keeps it optional for older plugins rather than fabricating a
value. Compiled-plugin coverage verifies a frame at .4 with paint at .7, a nested
child at zero, and a depth-zero read. All 39 compiled-plugin checks passed; MCP
typecheck and the plugin build passed.

A refreshed candidate (167 package entries) was inventory-audited and installed
into the same isolated project. Its integrity is recorded locally in the
acceptance runner output. It includes the new Markdown state-review module.
The refreshed public plugin requires live pairing before opacity verification
can complete. No additional design writes are authorized or required.

Recovery regressions: the authentication, pairing, document-approval and bridge
run passed 29 of 30 tests initially; the managed-project CLI subprocess hit its
15-second timeout. An isolated retry of both document-approval tests passed
(the subprocess test completed in about 4.4 seconds), without changing timeouts
or relaxing assertions. This is test evidence, not live restart acceptance.

### Live opacity verification and MCP-client restart passed

After importing/reopening the refreshed public plugin, the user paired it. The
bridge reported this connection as strict verification, with the correct file
key and no pending plugin-only ticket, so no additional approval was bypassed
or fabricated. Read-only inspection of `7:1506` through the refreshed installed
candidate confirmed surface node opacities 1, .899999976, .800000012 and
.400000006, each within 1e-6 of the requested values. Paint opacity remained 1.
The prior opacity verification gap is resolved for the live sample.

Restarting only the acceptance MCP client retained the shared plugin connection.
The new process explicitly selected the same target, reported ready, and read
the same set/variant IDs without issuing another pairing code. This verifies
client restart against a running shared bridge, not a full machine/bridge reboot.
No Figma design writes ran during these read-back/restart checks.

### Drift/notification regressions

All 43 selected component, diff, deprecation, activity and notification tests
passed. These are fixture/mock checks; no live Slack message was sent. Live
individual/automatic sync, external Slack delivery/deduplication and full
bridge/machine restart acceptance remain open.

## Live drift, notifications, deprecations and full bridge restart

The installed candidate read the current approved Figma file and generated a
separate temporary code baseline from its comparable variables. It compared 22
tokens; nine variables were skipped by the existing supported-category rules.
A clean baseline produced zero drift. Changing only temporary `primary` to
`#123456` produced exactly one value mismatch against Figma `#6f3cfa`, with no
missing-token noise. An explicit intentional-difference entry suppressed that
mismatch; expiring it restored the drift. Existing project files and Figma
resources were not modified.

The user approved exactly two labelled Slack test messages to Rift Labs
#general. A local relay added the acceptance label to the CLI's normal messages
and forwarded them to the configured Slack webhook without exposing it. Slack
returned HTTP 200/ok for the one-item drift alert and resolution alert. The
unchanged middle check made no delivery attempt. This verifies live acceptance
and suppression in this sequence, not exactly-once delivery across crashes.
The temporary primary value was restored afterward.

A second temporary fixture verified a pending code-only deprecation is
informational, an overdue deadline is drift, and removing the retired code token
produces one safe-to-remove registry entry. None of these checks sent Slack
messages.

The first normal bridge shutdown correctly refused an active client. Process
inspection identified the remaining Elf MCP client from this Codex session; it
was gracefully closed under the user's restart approval. The idle-only shutdown
then succeeded. The existing private pairing-store file was backed up privately
and remained byte-for-byte unchanged across the restart. The new installed
bridge exposes MCP client counts.

Live recovery uncovered a UI defect: immediately code-paired connections did
not reconnect with an issued saved session after a bridge restart. The reconnect
condition now uses the available saved session rather than requiring that the
previous authentication attempt already used session mode. Authentication and
wrong-file failures still return before retry. Regression coverage verifies the
fresh-code→saved-session transition and refusal of a bad pairing code. Normal
plugin manifests/selector also keep deferred hosted MCP out of the local release
path. All 113 MCP tests pass after this change.

After reopening the updated plugin, the user confirmed it connected without a
new code. The installed client's independent read of sample set `7:1506`
confirmed the same master/variant IDs and all four opacities; a CLI drift check
through the restarted bridge was clean. The first code-paired automatic retry
transition has automated UI coverage; the live post-restart recovery was verified
by reopening the updated plugin with the saved credential. Do not conflate the
two results. No Figma writes ran in this acceptance phase.

Still open: live component drift, individual/automatic managed sync, revoked-file
recovery, fresh-machine/platform coverage, distribution and final release audit.

## Managed component acceptance — in progress

The user approved the scope in managed-component-live-review.md: one isolated
AcceptanceManagedButton create, individual width 128, watcher widths 144→120,
stale-plan refusal, then pausing the temporary project. The unselected card
fixture was included in the full plan but excluded from the individual plan;
it was removed locally after selection verification and never created in Figma.
No tokens, styles or collections were in the selected write plan.

The initial create reached Figma at `10:1523`, but post-write verification
correctly refused to record success. Diagnosis isolated a shared CSS RGB bug:
0–255 channels were fed to a converter expecting 0–1, so nontrivial RGB paints
normalized incorrectly (the returned purple became white during verification).
The parser now normalizes numeric channels by 255 and percentages by 100.
Regression coverage verifies Figma float precision, percentage/slash syntax,
invalid numeric input and rejection of genuinely different colors/alpha. All
227 root tests and the root typecheck passed. Fix pushed as `4e8c835`.

Independent read-back confirmed every originally requested field on the
partially created owned sample. Its approved prose documentation was applied
separately using expected-description/codeKey guards. A fresh selected review
reconciled this exact owned sample without creating another master and recorded
a verified managed baseline. No existing user resource was adopted or overwritten.

CLI baseline: zero out-of-date/changed/missing code components; changing only
the temporary source added exactly one componentsOutOfDate item. However, this
file also has 213 unrelated Elf-tagged Figma component entries not present in the
fixture; both checks reported them unchanged as componentsInFigmaNotInCode.
The entire-file drift verdict therefore stayed true. Do not claim the isolated
project is globally clean or notify about this baseline as newly detected drift.
Unmanaged-resource scoping/import guidance is a release UX issue.

After reviewing a 128px update, changing the temporary description to 129px
caused apply to reject the stale plan before writing. Read-back remained 120px.
Restoring 128 and reviewing again produced a conflict-free individual plan;
application succeeded and read-back confirmed 128px on the same master ID.
Full-page planning took approximately 23–59 seconds on this existing page and
apply performs further scans; scope/performance is another release issue.

The full temporary-project review now has no writes or issues. Its approved
automatic-sync stage is next; do not mark the real watcher test passed until
144px and restored 120px are independently read back with committed manifests.
No additional Slack messages were authorized or sent in this phase.

### Managed watcher stage and final verification passed

The full temporary-project review had no writes/issues; applying it with the
user-approved automatic flag enabled only this fixture. The actual installed
`elf start --config ... --no-open --settings-port 0` watcher observed source and
description saves. It updated width to 144 and then 120; after each stage,
independent read-back confirmed the same master `10:1523`, and the manifest
committed a new source hash with synced status and a verified node hash. This
was a real file watcher test, not direct calls to autoSync after edits.

Automatic sync was paused before watcher shutdown. The watcher wrapper exited
and a process-count check found zero remaining acceptance watchers. Final read
confirmed 120 × 40, approved usage documentation, one managed master, no
unselected card, 25 top-level component resources, five collections and 31
variables. A final installed CLI check had zero value mismatches, missing
tokens, out-of-date components, changed-in-Figma components or missing source
components. Its 213 unrelated Figma-only entries matched the pre-test baseline
and the final drift fingerprint returned to that baseline. The overall drift
verdict therefore remains true; this does not establish a globally clean file.

No additional Slack messages were sent. Existing project files/configuration
were untouched; the only new resource in this phase was the approved managed
component. Remaining release issues include unmanaged-resource ownership/scoping
and the full-page scans that make individual review/application slow.

## Drift-ownership and scoped-sync rerun — approved temp-project writes

A fresh local candidate (`elf-tokens-1.0.0.tgz`, 167 entries, integrity
`sha512-Ix2G7NDOQduVL25WvFgM4ClQX…Q/hc0wiaQ==`) was packed after the
drift-ownership/scoped-sync fixes, installed into a new isolated npm project
(`/tmp/elf-accept2`), and every live path imported the runtime from that exact
install (installed `src/project.ts` is byte-identical to the fixed tree). The
existing isolated temporary project tracked exactly one component,
`AcceptanceManagedButton.tsx#AcceptanceManagedButton` at node `10:1523`, over
the same shared bridge + paired plugin connection (no re-pairing; connection
details unchanged; real project configuration untouched).

### Test 1 — drift ownership (passed, read-only on Figma)

With the isolated manifest tracking only the acceptance component:

| Phase | Tokens | Components | Full audit |
|---|---|---|---|
| baseline | clean | clean, **0 unrelated Figma-only rows** | 3.7 s |
| source-only width edit | clean | out-of-date: exactly 1 | 4.2 s |
| temp source deleted | clean | 1 Figma-only (surviving component reported) | 5.1 s |
| restored | clean | clean again | 3.9 s |

The 213 unrelated elf-tagged Figma components from earlier runs no longer
appear as component drift, and they remain discoverable through
`list_component_imports` (214 deep-listed entries incl. the managed one, listed
as import context, not as drift). Token and component results were reported
separately; tokens were clean throughout. The prior “60-second full audit” now
completes in 3.2–5.2 s on this file because unrelated components are no longer
scanned or fetched; both the full check and the scoped save-triggered sync run
through the same command surface but at distinct costs.

### Test 2 — individual review performance and safety (passed, with limits)

Instrumented through the installed package’s bridge calls:

- Individual review of the single tracked component: 450 ms, exactly 4 bridge
  calls — 1 `get_node` (the tracked component only — no unrelated bodies),
  1 each `list_collections` / `list_variables` / `list_components`. A full
  unscoped plan now costs 359 ms with the same scoped read pattern (prior run:
  23–59 s full-page scans).
- Applying a review revalidates resources before writing: the approved
  individual width update (120→128, see Test 3) took 3.27 s with 3 `get_node`
  revalidation reads plus exactly 1 `upsert_component`; manifest re-committed
  with new source/spec hashes and a node hash independently matching the live
  node state.
- A no-pending-write apply after a source change wrote nothing (observation);
  the strict stale-apply rejection with a pending entry and the
  connection-change / remote-edit rejections remain automated-tested rather
  than replicated live (see limits).

### Test 3 — real watcher-driven automatic sync (passed; approvals)

The user explicitly approved W1 (individual reviewed apply 120→128) and W2
(watcher 128→120) for this run. W1 confirmed: same master `10:1523`, height 40,
prose/corners/layout unchanged, and manifest committed. W2 ran the actual
installed CLI watcher (`elf start --config <temp> --no-open --settings-port 0`)
with automatic sync enabled only in the temporary project. A real file save of
source width 120 + sidecar width 120 was observed by the watcher (“Drift: 1
items.” then steady-state “Drift: none.”), applied to the same master, and an
independent mid-run read-back confirmed 120 while the manifest committed with a
new source hash and node hash. Offline verification recomputed both hashes from
the current files and live node state — both match the committed manifest
exactly (`sourceHash` `bf9228ab80e82dba`, `nodeHash` `9fb5adce5bac16ea`).
Automatic sync was paused and the watcher stopped before shutdown; no leftover
acceptance-watcher process remained. One caveat: the runner’s baseline-parsing
bug prevented capturing the exact save→read-back latency and the watcher’s
internal bridge counts for this sample (the wait that caught the manifest
commit was skipped); the write+commit itself is verified by independent
read-back and hash recomputation.

### Test 4 — regressions (passed)

`npm test`: 236/236 (root typecheck clean; batch: 53/53 and
`batch:typecheck` clean). Regression coverage confirmed by name for multiple
components in one source file and for deletion where the component name
differs from its filename.

### Final state and limits

Final independent read-back: `10:1523` at 120×40 with the approved prose
description; exactly 1 managed component; no unselected-card duplicate;
25 top-level components, 5 collections, 31 variables (baseline unchanged);
temporary automatic sync off; only this run’s temp processes stopped (unrelated
`elf-clean-*` processes from unfinished work were left untouched). Remaining
limited items: no live stale-with-pending-entry or connection-change/
remote-edit rejection (automated coverage only), no captured W2 latency sample
(a repeat approved cycle would be needed), macOS-only platform coverage, and
scoped sync with component dependencies was only exercised live for a
dependency-free component. Structured results are in `/tmp/elf-accept2-receipt.json`.
Only this run's temp processes were stopped; unrelated `elf-clean-*` processes
from the unfinished hosted-MCP work were left untouched.

### Watcher re-run: discrepancy resolved with a clean pass

Root cause of the earlier watcher timeout: the runner parsed the manifest
entry with `manifest[key]` instead of `manifest.components[key]`, so its
baseline was `null` and every poll threw and was silently swallowed — the sync
itself had already succeeded (verified offline by recomputed hashes). The
corrected runner (non-swallowed programming errors, per-stage persisted
results, redacted private logs) re-ran the approved cycle on the same temp
project with automatic sync in that project only:

| Watcher stage | save→read-back/commit | independent reads | hashes |
|---|---|---|---|
| 120→128 | 10.8 s | 11 | source + node hash changed |
| 128→120 | 6.4 s | 14 | source changed; node hash returned to the original state value |

The watcher was ready 3.9 s after spawn, applied both saves to master
`10:1523` with the description preserved, committed the manifest, and the
runner's offline recomputation of both hashes matched the live 120 node — the
restored node state is the exact original state value. Automatic sync was
paused and the watcher stopped with no leftover processes; final resource
counts remained 25 components / 5 collections / 31 variables with exactly one
managed component. The watcher acceptance is now a clean pass with captured
latencies; the W2 latency limitation no longer applies.

## Release packaging and final beta checks

The full prepublish build chain passed: root typecheck, MCP typecheck,
Settings-next typecheck + static build, brand assets and the public bridge
plugin build (`dist/bridge-plugin-public/manifest.json` emitted). Built
artifacts matched the staged tree (no unstaged churn). `npm pack
--ignore-scripts` produced `elf-tokens-1.0.0.tgz` (167 entries, integrity
`sha512-84/aWtZV76eIEQHPn7yUtud0xOQhIUCT/Gk1VFDVfCHWJfRtMseIkbmCy9SIVUxgvydEz
4pRtilCQmF0rhCLrA==`) into `/tmp/elf-local-accept3`; the inventory audit found
zero forbidden entries (no `.env`, `.dev.vars`, `.elf`, project configs,
private Rift Labs documents, hosted-preview or draft state) and all required
shipped entries present. Nothing was published, deployed, committed or pushed.

Final beta checks (local only): notify drill passed against a local capture
webhook (no Slack delivery); worker checks passed 30/30-equivalent with
delivery failure handling proven; watch suite 21/21 plus typecheck; MCP suite
113/113 plus typecheck (an initial single failure while suites ran in parallel
was a local resource race and did not reproduce on two isolated reruns);
console suite 90/91 with typecheck clean. The one console failure is the new,
untracked `console/test/hosted-plugin-auth.test.ts`
(“requires plugin approval without an account…”): `/consent/finish` returns
400 after a 200 bridge approve — the approved-row join guard
(`hosted_plugin_consents.approvedGeneration` / `hosted_connections
.approvedGeneration` / heartbeat window) disagrees with the bridge-approve
state at finish time. It reproduces in isolation via
`npx vitest run test/hosted-plugin-auth.test.ts` inside `console/` and belongs
to the in-progress hosted plugin authorization work, not to the managed
drift/sync fixes shipped here. Root typecheck and root tests (236/236) remain
green with the packaged source.

Beta state: the drift-ownership/scoped-sync fixes are packaged and live-verified;
the open items are the hosted plugin-consent red test above, fresh-machine and
cross-platform coverage, and macOS-only managed-dependency scoping evidence.
