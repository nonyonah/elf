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

## Component import preview (0.3.6)

Choose **Manage → Import Figma component** or **Elf: Import Figma Component**.
Select the live Figma component, confirm React TSX, choose native HTML elements or
one of the supported libraries declared in this project's root package manifest,
and explicitly select local React components to reuse. Choose a new PascalCase
`.tsx` file in an existing source folder. No dependency installation is performed.
In a monorepo, use the intended application package as the Elf project root.

Inspect the design context, then choose AI generation or a manual draft. AI uses
an editor-provided model and requires consent before sending the displayed Figma
node, token values, choices, and selected reuse names/paths. Local component source
is not sent. Review assumptions and unsupported details, edit the right-hand code,
and use **Create Reviewed Component** in the editor or its row in Changes.

The shared engine checks syntax, the export name, allowed imports, restricted
APIs, project paths, and source/Figma/connection freshness. It creates a new file
exclusively and pauses automatic sync. It never executes generated code, loads
project compiler plugins, installs packages, overwrites components, or writes
Figma. Static checks are defense in depth, not a sandbox or a complete audit.
Review semantics, library APIs, responsive layout, keyboard/focus behavior,
accessibility, and assets in your application before using the result.

The read is limited to six node levels, fifty children per node, and up to two
hundred variables. These limits and truncation are disclosed in the context.
React TSX is the first output adapter; Vue and Svelte generation remain pending.
A new code file does not automatically adopt a managed Figma sync baseline or
create a Figma description. Those need their own review before exporting code
back into an existing design resource.

npm Settings provides the same choices and a manual code editor/context for a
coding assistant. MCP provides `list_component_imports`,
`prepare_component_import`, `validate_component_import`, and
`apply_component_import`. Pass the exact reviewed code to apply, and obtain
human approval first. Drafts expire after thirty minutes; after an editor reload,
prepare a fresh import context rather than reusing an expired approval.

## Export creates and updates from the Figma plugin (0.3.6)

After upgrading, close Elf MCP clients and use **Elf: Restart Shared Bridge** in
the editor. The command preserves pairings and refuses to stop other active
clients. Close and reopen the updated plugin, then renew document approval if
needed. Older hosts leave the export button disabled with a restart instruction.

Keep Elf running in the editor or through `elf start`. In the connected plugin:

1. Choose **Export code changes to Figma** and select the registered local project.
2. Refresh the changes. Missing resources show **Create**; edited ones show **Update**.
3. Select a resource to review it and its required dependencies.
4. Read the planned writes and issues, explicitly confirm replacement if there
   are Figma conflicts, then choose **Apply reviewed changes**.

Components without valid reviewed descriptions must be prepared in Elf first.
The plugin cannot read arbitrary local paths, install dependencies, or turn on
automatic sync. Requests are restricted to registered projects matching the
approved Figma file. The authenticated bridge forwards only list, review, and
apply operations to the same local project engine used by npm and the extension.
Stale plans, dependency checks, write verification, and notifications stay in
that engine. A pairing alone, without a running local Elf project, does not
provide access to project code. No REST variable reads are needed in plugin mode.

### Library selection and setup

Component imports offer native elements, Material UI, Mantine, shadcn/ui, HeroUI v3, and supported libraries already declared in the project. Existing local components can be selected for reuse; shadcn components are local source components, with a separate interactive setup recipe.

Select **Review library setup** in npm Settings, or choose the library in the native extension. Elf displays a fixed installation recipe, official guide, and required provider/framework steps. It detects npm, pnpm, and Yarn lockfiles. The extension can place the reviewed command in a project terminal; you press Enter yourself. Commands disable installation scripts. No dependency is installed by merely choosing a library, and application entry points, providers, PostCSS, and SSR settings are never rewritten automatically. Review peer versions before installing. Complete setup, then continue; Elf verifies the library declaration and remembers the selection. This check does not prove the provider or application build is correct. Run the project's own build and visual checks.

Recipes follow [Material UI installation](https://mui.com/material-ui/getting-started/installation/) and [Mantine setup](https://mantine.dev/getting-started/). React TSX remains the supported import adapter.

Description references accept an exact token key first, then a unique separator-equivalent key (`spacing.2` → `spacing-2`). Ambiguous aliases are rejected. Type checks still apply, and missing references show available keys. Editing a private AI draft does not update a component sidecar until **Save reviewed description** succeeds.

Description uploads can be saved with missing, ambiguous, or wrong-type token bindings. Validation and saving return `warnings` and `syncReady: false` while preserving the description exactly as reviewed. Schema, source-revision, path, and variant checks remain enforced. Saving pauses automatic sync; sync planning still blocks unresolved component bindings. Elf never invents token values or silently removes bindings to make an upload succeed. The extension and npm Settings confirm the local save without launching a failing sync review automatically.

#### shadcn/ui and HeroUI v3

Both are first-class library selections in the extension, npm Settings, and MCP catalog. shadcn readiness is detected from a readable local `components.json` with style and UI alias metadata. Its reviewed setup command uses the project package runner to launch interactive `shadcn init`; unlike package installation with scripts disabled, this CLI executes downloaded code and can change project CSS, configuration, and dependencies. Elf never runs it automatically. Add the UI components you want with the CLI, refresh project choices, then explicitly select local files to reuse. Generated drafts use relative imports only to those selected files, never a fictional `shadcn` package. The config participates in stale-review detection.

HeroUI uses the v3 package line (`@heroui/react@^3`, `@heroui/styles@^3`). Elf checks declared React/React DOM 19+ and Tailwind v4 prerequisites and does not upgrade them automatically. HeroUI v2 does not count as ready. Import Tailwind before HeroUI styles in your application CSS; no HeroUIProvider is needed. Generated context includes v3 guidance, and draft validation rejects the v2 provider import. Dependency declaration checks do not replace peer resolution, CSS setup, or application testing.

References: [shadcn installation](https://ui.shadcn.com/docs/installation), [HeroUI v3 quick start](https://heroui.com/en/docs/react/getting-started/quick-start).
