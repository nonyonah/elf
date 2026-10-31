# Local MCP live acceptance review

Target: Untitled, file key `eu8zGUOsrdyXXQqvJeyl1E`.

The installed npm candidate successfully approved the user-confirmed fresh
plugin-only connection and read 3 collections, 28 variables and 23 top-level
component resources. That includes 16 component sets and 7 standalone components.
These are the existing Rift Labs resources, not an empty test file.

The same installed client prepared the project-local acceptance Markdown and
returned its source hash and extraction instructions. Preparation did not write
to Figma. The local Markdown workflow is extraction/review followed by explicit
MCP resource tools; it is not a one-call combined design-system importer.

## Proposed test writes — awaiting approval

Create two uniquely named collections, each with one Default mode:

| Collection | Variable | Type | Value |
| --- | --- | --- | --- |
| Elf Acceptance Color | primary | COLOR | #6F3CFA |
| Elf Acceptance Color | on-primary | COLOR | #FFFFFF |
| Elf Acceptance Spacing | control-height | FLOAT | 40 |

Create `Elf Acceptance Button`, codeKey `elf-acceptance/button`, with a State
property and four variants: Default, Hover, Pressed, Disabled. Each is 120 × 40,
with 8px corners, 16px horizontal and 8px vertical padding. The label is
“Continue”, Inter Regular 14, white text bound to on-primary; purple background
bound to primary. Owned frame layers represent state opacity: 1, .9, .8, .4.
The test validates representation and bindings, not production accessibility.

Description: “Runs one immediate action. Use a short verb label. Disabled means
the action is unavailable; retain a readable label.”

The component API accepts literal dimensions, so control-height is created and
read back as a FLOAT variable but is not claimed as a bound height. Prototype
transitions are outside this test. Any additional unsupported property discovered
while preparing the exact payload must be reported before applying it.

After application, independently read collections, variables, component variants,
bindings and prose metadata. Repeat the identical explicit upsert to verify IDs
are preserved without duplicates. Do not modify existing Rift Labs resources,
delete the test output, or adopt a project drift baseline as part of this test.
