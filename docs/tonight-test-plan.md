# Elf live test plan — 27 October 2026

Run these in order. Record failures and fix blockers before moving to the next
stage. Use a test Figma file and a Slack test channel for actual writes/messages.

## Current release

- Implementation commit: `eef9146`.
- OAuth migration `0005_local_oauth.sql`: applied to the live Console database.
- Worker deployed from that committed release, excluding local uncommitted edits.
- Deployed Worker version: `a08f8bec-5aad-42b6-b5ce-3ae3031b4dc9`.
- Health endpoint passes. Both OAuth routes accept configured requests and
  redirect to their providers. This does not yet prove successful authorization,
  credential exchange, Figma access, or notification delivery.
- The updated npm package and public Figma plugin are not published.

## Progress and current validation

### Native editor preview — 28 October

- Local extension 0.2.5 is installed: Overview, Changes, Activity, and Manage.
- Drift categories expand to individual resources; read-only detail documents
  avoid unsaved-buffer prompts. Unchanged checks are deduplicated by fingerprint.
- 30 extension tests and 97 MCP tests pass, along with targeted core checks,
  root/MCP type checks, and the Settings/plugin production builds.
- The old shared bridge was replaced after stopping its remaining extension
  client; saved pairings were retained. The replacement advertises account renewal.
- A live Figma read returned HTTP 429. Verification now respects a cooldown and
  reports rate limiting explicitly. A successful live reconnect after that limit
  clears still needs confirmation. Do not treat stored account status as proof.
- The extension remains a local preview; no npm or Marketplace release occurred.

User-confirmed live passes: Slack/Figma sign-in, public-file verification,
pairing/reconnection, token sync and browser reports, and individual Slack drift
alerts. The initial deployment details above record the first rollout; subsequent
fixes are recorded in Git history.

The component review flow is now available locally in Settings; the user confirmed
that Alert's form opens and shows the token-reference warning. See
[the component review guide](component-review.md). Its live Figma apply still
requires the user's design and sync-plan review.

Automated checks completed for this iteration:

- 31 component/project, deprecation, and intentional-difference tests pass.
- 22 Settings/startup integration tests pass; root/MCP type checks and the
  production Settings build pass.
- A browser check with mock APIs passes preparation, editing, explicit review,
  stale-save handling, draft preservation, and save without an apply request.
- A local tarball installs in a fresh project. Automatic discovery, onboarding,
  monitoring, report generation, and MCP handshake/list/prepare/reviewed-save/
  plan/check pass against an isolated mock bridge without Figma writes.
- Package contents include Settings and the public plugin bundle; no private
  account, webhook, `.env`, or `.elf` credential files are included.

Live component creation passed: with explicit approval, Elf created only Divider
in the paired Untitled file (`73:6`). A separate Figma read verified a horizontal
80 × 1 component bound to `color-primary-500` (`#0f172a`). Token snapshots and
existing component references were unchanged; automatic sync stayed off.

The user subsequently reported completing the follow-up tests. This is a
user-reported pass; individual outcomes for component updates, conflicts,
divergence/deprecations, and assistant-client checks have not been recorded
separately. Keep that distinction from automated and independently observed results.

The latest local checks also pass: 16 project tests, 21 Settings API tests,
root/MCP type checks, the production Settings build, and browser checks that
unrelated conflicts allow a reviewed apply while dependency conflicts block it.
Restart the local CLI to load Settings API version 6 and these review controls.

Follow-up validation: all 171 core tests and all 97 MCP tests pass. An isolated
45-test run covering deprecations, notifications, project safety, Settings API
errors, and startup also passes. Local-server suites require loopback-listener
permissions; the sandbox-only MCP attempt was blocked by `listen EPERM`.

The latest local tarball also installs in a new disposable project: automatic
discovery, onboarding, monitoring, report generation, and MCP handshake/list/
prepare/reviewed-save/plan/check pass against an isolated mock bridge. No Figma
writes were made. The 143-file package audit includes Settings/public-plugin
assets and excludes private credentials. This does not establish npm publication
or compatibility with every editor client.

Remaining live checks: component updates/conflict handling, the chosen
project's intentional divergences and deadlines, and assistant-client use against
the real paired file. The extension is the planned primary interface, with the
implementation tasks below. Public releases remain later work.

## 1. Connect both accounts — first priority

Start the local release from this repository:

```sh
node bin/elf-tokens.js start
```

Open its private Settings link. Stop/restart any older Elf process if Settings
reports an incompatible server. Never share the private link or pairing secrets.

- [x] Connect Slack (user confirmed live sign-in succeeds). Settings must show the selected
  workspace/channel. No manually supplied webhook should be necessary.
- [ ] Use the explicit Slack test-message action and confirm delivery.
- [x] Connect Figma and return to Settings with account status connected (user confirmed).
- [ ] Cancel each authorization once, then retry successfully.
- [ ] Disconnect/reconnect each account. Old callbacks must not restore a
  disconnected account or leak credentials into URLs or browser responses.

If authorization fails, check the registered callback URL, scope, app publishing
or distribution status, and workspace policies before changing client code.
See [both app registrations](connection-service-setup.md).

## 2. Verify public-plugin identity and persistent pairing

- [ ] Import the prepared `dist/bridge-plugin-public/manifest.json` into Figma Desktop
  for testing. An imported development build does not prove Community approval.
- [ ] Open the test file, paste that file's URL, and pair using the terminal code.
  Verification must complete before any resource request can run.
- [ ] Reopen the plugin and restart Elf: the saved pairing reconnects without
  another code. Repeat after switching between two separately paired files.
- [ ] Copy the file and try the original URL. The mismatch must block writes;
  use the copy's own link and pairing to connect it.
- [ ] Hide the plugin window and confirm work continues. Close the plugin and
  confirm Elf reports disconnection and resumes safely when reopened.
- [ ] Revoke a pairing and confirm the saved credential cannot reconnect.

The public flow writes a nonvisual proof marker and requires document edit
access. Allow the file to save before retrying verification. Also test the
development manifest separately; its native file-key path remains supported.

## 3. Token sync, report, and per-resource alerts

- [ ] Review discovered sources without entering folder paths. Add a new token
  file in a normal source directory and confirm discovery updates.
- [ ] Review a sync plan and apply one supported token change. Confirm the value
  in Figma Variables and in Settings' synced-resource inspection.
- [ ] Confirm the bell shows that resource's before/after change. Mark it read,
  clear it, and reopen Settings to verify notification preferences persist.
- [ ] Use **Check now**, then **View report**. Both must work without JSON errors;
  the report should be readable in the browser and the resource panel closable.
- [ ] In monitoring mode, change one code token without applying it. Confirm
  drift appears for that token and a Slack alert reaches the test channel.
- [ ] Repeat an unchanged check: no duplicate Slack alert when only-on-change is
  enabled. Resolve the drift and verify the report/activity state updates.
- [ ] Enable automatic sync through a reviewed plan, edit a token, and verify
  just the supported change is applied, verified, and reported.

Do not infer drift-alert failure from a successful automatic sync: a supported
change that has already been synced may leave no mismatch to alert on.

## 4. Component behavior and intentional divergence

- [ ] Discover a component in an ordinary project source folder automatically.
- [ ] Prepare/review its `.figma.json` description and sync a component/variant.
  Verify the actual canvas node, resource link, and activity entry.
- [ ] Change a supported described property: confirm the plan and Figma result.
- [ ] Change implementation only: confirm it is reported as needing attention,
  rather than falsely claiming the visual design was synchronized.
- [ ] Edit the managed node in Figma: automatic writes must pause for review.
- [ ] Remove/rename code: the Figma resource must not be silently deleted.
- [ ] Register an intentional divergence/deprecation with a reason. Confirm its
  report classification and notification treatment; test overdue removal dates.
  Use [the drift test guide](testing-drift.md) for supported registry/JSDoc syntax.

Arbitrary JSX-to-Figma visual reconstruction is not implemented. Record a
supported-property failure separately from a request for a new rendering feature.

## 5. Assistant and package experience

- [ ] Connect one assistant first (Cursor, Claude Code, or Codex) using the
  Settings snippet. Check, plan, and apply against the same project/file.
- [ ] Run watcher and MCP together: confirm shared pairing, serialized writes,
  consistent manifests/activity, and safe handling of a disconnected plugin.
- [ ] Test the other assistant clients after the first passes.
- [ ] Install a local package tarball in a fresh disposable project: verify
  packaged Settings assets, plugin files, automatic discovery, onboarding, and
  first sync without cloning Elf. Confirm secrets/private local state are absent
  from the package. Do not publish to npm as part of this check.

## 6. Extension as the primary interface — agreed product direction

The normal designer workflow should run inside VS Code without cloning Elf or
keeping a terminal open. Keep the CLI and MCP as supported interfaces to the same
engine. The Figma plugin remains necessary for live Figma writes.

The development preview lives in `extension/` (see its README). It adds a native
Elf activity-bar view, status indicator, onboarding actions, pairing-code access,
native text reports with per-category drift summaries, Slack/Figma connections, notifications,
sync review, per-resource activity changes, and Stop for an explicitly started,
bundled runtime. Overview, Changes, and Activity separate daily work from connections and
preferences in the Manage menu. Component descriptions open in a native diff editor. Only account authorization opens the browser.
Session credentials stay in the host and all API calls use an allowlisted native
bridge. AI generation and imports are not implemented. Startup requires a trusted
local workspace; reloading the editor stops the owned monitor.

- [ ] Design extension onboarding using the current Settings visual style:
  select the project, connect Slack/Figma, choose a Figma file, and pair once.
  Show the one-time pairing code in the extension instead of requiring a terminal.
- [ ] Manage the local bridge/watcher lifecycle from the extension, including
  start, stop, status, version compatibility, and recovery after reopening VS Code.
- [ ] Add project status, Check now, browser/editor report viewing, native
  notifications, per-resource changes, and links to source files and Figma
  resources. Status, checks, report/diagnostics, native activity notifications,
  activity changes, and Figma resource links are implemented; source-file links
  remain.
- [x] Reuse the component prepare → edit → review → save → plan → apply flow,
  including stale-review protection and explicit write approval.
- [ ] Add native token suggestions/context alongside description drafts; the
  former Settings form suggestions are not yet available in the diff editor.
- [ ] Finish live acceptance of AI-generated component-description drafts in the extension, using the
  selected component source, discovered tokens, existing descriptions, and
  framework/library context. Show inferred values and unsupported behavior for
  review; generation must not save files or apply Figma changes automatically.
  Reuse schema/token validation and stale-review protection. Obtain consent
  before sending source to an external model; keep credentials in editor secret
  storage and project source out of diagnostic logs.
  Local preview 0.3.1 implements editor model selection, context preview,
  per-request consent, bounded generation, assumptions/unsupported notes, shared
  validation, and a reviewed diff. Mock-based tests pass; no live model has been
  called during implementation. Component discovery and validation are also
  available to MCP; native JSON token completion and context inspection exist.
- [ ] At file connection, offer **Code → Figma**, **Figma → Code**, or
  **Compare only**. A missing-in-code finding should offer an import action.
- [ ] Implement Figma token import first: inspect variables, detect the project's
  token format, preserve supported modes/aliases, preview file changes and naming
  conflicts, then write only approved changes. Preserve existing files/resources.
- [ ] For component imports, detect the framework/styling setup and ask users to
  confirm the component library, existing-component reuse, and output location.
  Prepare reviewed drafts; identify missing behavior/accessibility and unsupported
  visual details rather than claiming a complete reconstruction.
- [ ] Keep provider app secrets on the Worker and credentials out of webviews.
  Require a trusted workspace before starting watchers or writes. Use a controlled
  runtime installation/update path and authenticated local bridge connections.
- [ ] Test first installation with no terminal setup, multiple projects, editor
  reloads, revoked accounts/pairings, offline recovery, and watcher/MCP coexistence.

Finish the remaining core live checks before implementing the extension; extend
the shared engine for imports so Settings, MCP, and the extension stay consistent.

## Work after the live tests

Fix blockers in this order: account exchange/file verification, unsafe or
incorrect writes, missing drift detection/Slack delivery, then Settings and MCP
usability. Add regression coverage for confirmed failures and push the fixes.

Before public release, finish Figma OAuth/public-plugin review, Slack distribution,
fresh-project package testing, and release documentation. Publish the npm release
and plugin only after the live checks pass and the release is approved.

Keep local test-fixture edits and in-progress Console UI changes out of release
commits unless they are explicitly reviewed as part of that release.
