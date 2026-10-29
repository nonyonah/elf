# Review a component before syncing

In Settings, select **Review sync**. Components with missing or invalid
descriptions, or implementation changes needing review, have a **Prepare
description** action.

Preparation opens an editable draft without changing Figma or saving a file.
Existing descriptions are preserved. If there is no usable description, Elf
shows clearly labelled starting values; these are not a reconstruction of the
component's appearance.

1. Review the layout, dimensions, label, spacing, and background token.
2. Review the discovered variants and their background overrides. Use the
   advanced description for child components, token bindings, and other overrides.
3. Check the component source and available token names when needed. References
   from another token source must be replaced with references in this project.
4. Confirm that you reviewed the draft, then select **Save reviewed description**.
5. Select **Review sync** again. Inspect the new component/variant changes and
   conflicts before choosing **Apply sync**.

Saving writes the adjacent `.figma.json` file, pauses automatic sync, and records
the review. It does not apply a Figma change. If the component or its description
changes while the draft is open, Elf rejects the stale save; prepare it again.
Unknown fields, invalid variants, unresolved tokens, and unsafe paths are rejected.

## The Alert fixture

`batch/test/fixtures/components/Alert.figma.json` belongs to the batch JSON-token
example. The currently configured CSS token source uses different names. For
example, `space.4` is not the same reference as `spacing-4`, and the CSS source
does not define `semantic.color.surface` or `fontSize.body`.

Choose from the available project tokens instead of copying references from the
batch example. For a simple test, spacing can use `spacing-4` and `spacing-2`,
font size can be the literal `14`, and variant backgrounds can reference available
color tokens. Review the actual design intent before choosing those colors.

These are test fixtures: saving a new description there changes the batch test
inputs. For continuing live design work, use a component copied into a normal
project source directory with its own token source and description.

## Coding assistants and the editor extension

The same project service backs Settings and MCP. An assistant calls
`prepare_component`, presents the draft, then passes its `reviewHash` with
`save_component_description` after explicit review. It then calls `plan_sync`,
presents the plan, and applies only the approved changes.

The editor extension reuses the returned component identity, draft, warnings,
token list, and review hash in a native diff editor and the Elf activity-bar
view. The extension is implemented; AI-generated descriptions remain planned.

AI-generated descriptions are planned for the extension. Generation should use
the selected component's source, framework/library context, existing description,
and available project tokens to produce an editable draft. Inferred appearance
and unsupported behavior must be visible for review. The same validation and
review hash checks apply; generation alone must neither save a description nor
write to Figma. Source must only be sent to an external model with the user's
consent, and model credentials must stay in editor secret storage.
# Rich MCP component previews

## Interaction states and safe variant updates

Use `upsert_component_set` with separate properties such as `Style`, `Size` and
`State`; checked/selected/expanded values belong in their own properties. Supply
the default variant first when promoting an existing master. A direct child
master with the exact `codeKey` becomes that first variant: its Figma ID and
existing instance attachments are retained. Name-only promotion is not allowed.
Updating Elf-owned visual layers can reset overrides within those layers; this
does not promise preservation of every nested instance override.

Adding states preserves the set and matching variant IDs. Unrequested variants
are retained and returned as `retainedVariants`; omission is not a deletion.
Changing property names/order requires a separately reviewed migration and is
refused. The response includes `promotedComponentId`, actual `variantCount` and
requested variant IDs. Sets support up to 256 variants. MCP checks the plugin's
`safeVariantUpdates` capability before writing, and older plugins are refused.

Default, hover, pressed, focus, disabled and loading are distinct visual states;
their presence does not wire prototype transitions or implement browser behavior.
Use semantic properties such as `Tone` for noninteractive status messages instead
of manufacturing hover/disabled states for static content. Never represent a
hidden dialog or tooltip with an empty component just to create a Closed state.

The local MCP `upsert_component` and `upsert_component_set` tools accept bounded
declarative `layers`: frames, text, rectangles, ellipses and point-based vectors.
Layers form a flat ordered tree; `parent` is the index of an earlier frame.
Each component/variant accepts at most 200 layers, depth 8, under 64 KB. Fonts,
variable references and geometry are checked before creating canvas nodes.
Scripts, external assets, URLs and arbitrary SVG input are unsupported.

Use an explicit matching `codeKey`. Rich writes refuse name-only adoption of an
unowned component. Repeating a layer write replaces Elf's own visual roots and
preserves unrelated sibling layers. Designer edits inside an owned visual root
are part of that replacement; inspect and review existing work before updating.
Figma operations are not atomic and no complete rollback is promised.

`description` writes plain usage prose to Figma's Description field; `position`
places the component or set on the canvas. These fields are separate from visual
specification data. `stroke` supports literal or variable-bound colors. Read
back descriptions, positions, strokes, layers and vector paths with `get_node`.

New fields require the updated Figma plugin. MCP checks plugin capabilities and
refuses these writes on older plugins rather than silently omitting fields.
Close/reopen the plugin and restart MCP after updating the local package.
Static examples do not implement ARIA, validation or keyboard behavior. This
primitive renderer does not complete the combined Markdown plan/apply workflow
or create documentation pages automatically.
