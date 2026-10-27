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

- [ ] Import the prepared `bridge-plugin/manifest.public.json` into Figma Desktop
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

## Work after the live tests

Fix blockers in this order: account exchange/file verification, unsafe or
incorrect writes, missing drift detection/Slack delivery, then Settings and MCP
usability. Add regression coverage for confirmed failures and push the fixes.

Before public release, finish Figma OAuth/public-plugin review, Slack distribution,
fresh-project package testing, and release documentation. Publish the npm release
and plugin only after the live checks pass and the release is approved.

Keep local test-fixture edits and in-progress Console UI changes out of release
commits unless they are explicitly reviewed as part of that release.
