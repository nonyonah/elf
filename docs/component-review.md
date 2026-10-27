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
