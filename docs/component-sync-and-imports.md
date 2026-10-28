# Component review, individual sync, and token imports

## Save an AI description and sync it

Review the right side of the description diff and the AI assumptions first.
Use the editor's **Save and Review Component Sync** action, or the matching row
in **Elf → Changes**. Each open draft has its own row, so the action works even
when the AI notes document is focused.

Confirm saving the local description. Elf then prepares a review for that
component. Inspect the listed writes and conflicts and choose **Apply sync**.
Saving or generating a description does not write to Figma. Editing the source,
description, configuration, or Figma after review requires a fresh review.

After upgrading/reloading, use **Elf: Recover Open Description Draft** on a saved
right-hand draft to attach it to a new validated review.

## Sync individual resources

In **Changes → Project components**, choose **Review this component sync**.
Components without a valid description show **Generate Figma description** and
**Prepare description manually**. Deprecated components are retained without
these prompts or sync actions.

Click a resource in a planned-change list to narrow the review to that resource.
The command palette also provides **Elf: Review Individual Resource Sync**.
Required tokens, aliases, and component dependencies are included in the review;
unrelated resources are excluded. Individual reviews cannot enable project-wide
automatic sync. Dependency conflicts and stale-review checks still apply.

npm Settings offers **Review only** beside each planned resource. Saving a
browser description opens its individual component review. MCP's `plan_sync`
accepts an optional `selection: {kind, key}` and returns the exact plan for review.

## Import existing Figma tokens

Use **Manage → Import Figma tokens**, or **Elf: Import Figma Tokens**. npm Settings
has a **Figma → code** import section. Keep the paired document open and approved.

1. Choose a new project-root filename such as `figma.tokens.json`.
2. Review the complete JSON preview, skipped names, and limitations.
3. In Changes choose **Apply reviewed token import** and confirm creating the file.

The shared engine preserves collection names, every mode, source variable IDs,
and alias source metadata. It includes resolved values for comparison and use in
code. Existing code names are skipped. Matching variable names across collections
receive collection prefixes, with stable ID suffixes for remaining collisions.
Collection IDs and original names are preserved; aliases and bridge checks use
the same distinct code names. Alias cycles block the import. Plans expire after ten minutes and reject changed code,
configuration, Figma content, or connection identity. Applying an import pauses
automatic sync and creates the file exclusively; it never overwrites a file or
writes to Figma.

The result is **Elf JSON**, with values under `tokens[name].value` and mode values
under `tokens[name].modes[mode]`. For example, application code can import the JSON
and read `tokens['color-brand'].value`. Root `*.tokens.json` files marked as Elf
imports are automatically included in checks, including projects with a legacy
explicit token path. Projects with these imports use the bridge for live variable
comparisons so collection identity stays aligned; strict document authorization
still uses its existing verification policy. Imported tokens also appear as component-description token
references using their original Figma variable names.

This first pass does not rewrite CSS/Tailwind, adopt imported variables for
reverse writes, or generate component code. Boolean and unclassified numeric
variables are preserved in the file but are outside the current drift categories.
Reverse token migration needs a separate review. Component imports will require
framework, library, reuse, and destination choices before code generation.

MCP provides `plan_token_import` (optional filename and variable IDs) and
`apply_token_import` (reviewed plan ID). Present the exact preview and obtain the
user's approval before applying. The native, npm, and MCP adapters share the same
validation and write safeguards.
