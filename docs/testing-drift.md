# Testing drift locally

Run `npx elf start` from your project and keep its terminal open. Open the
paired Elf Bridge plugin in the configured Figma file. Monitoring checks code
saves and checks Figma again every minute while connected.

In Settings, pause automatic sync to test a mismatch without immediately
correcting it. Use **Check now**, then **View report** to inspect the result.

## Components

Elf discovers component files automatically, including components across multiple
source folders. Onboarding shows discovered token sources and the component
count. Settings has no component-folder control. Newly added source files are
discovered while monitoring.

Discovery skips dependencies, generated output, hidden files, test/fixture/example
trees, stories, and symlinks, and respects `.gitignore` files. Component identities
are relative to the project root and stay stable when new folders are added.
Existing explicit config mappings remain supported for projects with sync history.
The bundled `batch/test/fixtures` directory is excluded from automatic discovery;
it remains usable through an explicit test configuration.

Components without a managed sync baseline appear as not yet synced. Review
and apply a sync plan to establish a baseline. Components need valid Figma
description sidecars, and referenced tokens must exist in the configured sync
token source. The bundled component descriptions reference
`batch/test/fixtures/tokens.json`; they cannot be resolved from unrelated CSS
tokens. Set `sync.tokens` to that file when intentionally testing that fixture
design system, then review the entire resulting plan before applying it.

After a successful component sync, edit its TSX implementation or description
and save. The report identifies that component. Implementation edits require
description review; Elf does not infer a rendered layout from arbitrary JSX.
Edit the linked Figma component to test drift in the other direction.

Token sources can be split across CSS and token JSON files. Equal duplicate
values are merged; conflicting values fail the check with the two source paths.
Tailwind themes are read statically without running config code or plugins.
Dynamic themes must expose their resolved tokens in CSS or JSON.
An empty project can finish setup and add design resources later.

## Notifications

Connect Slack and enable drift notifications in Settings. A first alert gives
a bounded summary; subsequent alerts list new, changed, and no-longer-reported
items, with the number of unchanged items. Repeated edits to an already
drifting component count as changes. Successful managed syncs send their own
resource changes, including recorded before/after values. Full sync details
remain in Settings notifications and synced resources.

Check status and notification delivery have separate state. Failed deliveries
are retried on the next check, and notification failures appear in Settings.
Delivery is at least once: a crash after Slack accepts a message but before
local state is saved can cause a duplicate. The sync retry history is bounded
by the most recent 50 project activity events.

## Deprecation and intentional differences

Use the existing `deprecations` registry with a reason and optional `removeBy`
date. An item intentionally missing from Figma remains informational until
overdue. Deprecated resources are retained without managed writes. Other
value or component changes still count as drift. A resource remaining only
in Figma is not declared fully retired.

TSX/JSX components also recognize a JSDoc `@deprecated` tag attached to the
named component declaration. Use the registry for deadlines, other component
formats, and token deprecations. A string mentioning `@deprecated` is not an
annotation.

For a deliberate token value difference, add an exact reviewed pair to
`elf.config.json` (use the values shown in the drift report):

```json
{
  "intentionalDifferences": [
    {
      "name": "color/primary",
      "figmaValue": "#111111",
      "codeValue": "#222222",
      "reason": "Platform-specific contrast requirement",
      "expires": "2026-12-01"
    }
  ]
}
```

Include `mode` when the reported mismatch has a mode. Only this exact pair
is accepted; expiry or a new value reopens drift. Accepted differences remain
visible in the report. While these rules are configured, automatic sync is
paused to protect the exception. Explicitly reviewed manual sync can replace
the accepted difference. Component value exceptions are not supported by this
token-specific registry.
