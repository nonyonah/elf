# Rift Labs — component visual proposal

Status: proposed for review; no component writes authorized by this document.
Source: `docs/DESIGN_SYSTEM.md`. Scope: all 23 documented component sections.

This is a Mira/shadcn-inspired interpretation of the supplied design direction,
not a claim to reproduce an official Mira preset. Values below fill gaps in the
source and require review. The existing 26 foundation variables remain unchanged.

## Shared visual rules

- Inter for interface copy: Body 14px, Caption 12px, headings 16/20px and Display
  26px. JetBrains Mono 13px for money, counts and data. Regular body and Medium
  labels are proposed; the Markdown does not prescribe font weights.
- Paper 000 surfaces, Ink 900 text, Ink 500 secondary text, Line borders and
  Accent for primary interaction. Signal colors retain their documented meaning.
- Use the existing 4/8/12/16/24/32/48 spacing variables. All numeric sizes below
  are pixels. Padding notation is vertical × horizontal.
- Proposed control radius 4px, field/container radius 6px; preserve the specified
  12px shell radius. These two new radii would be added only after approval.
- Borders 1px. Focus indicator: 2px Accent outline with 2px offset, as documented.
  Keep keyboard focus separate from hover, selected, checked and error states.
- No shadows on embedded cards. Floating menus/dialogs may use a restrained
  elevation treatment; the draft does not yet specify a shadow recipe.
- Primary buttons: Accent background, Paper 000 label. Secondary: Paper 000,
  Ink 900 label and Line border. Ghost: transparent with Ink 900 label.
  Destructive: Signal/red background and Paper 000 label. Warning banners use
  Ink 900 text with amber indicators rather than small amber body text.
- Widths are initial preview widths, not rigid responsive constraints. Text
  containers hug or fill their parent as appropriate. Heights marked “auto”
  expand with content. Figma presentation must not clip longer text.
- Icons follow the supplied outline/grid guidance. No icon library or package
  will be installed as part of this Figma-only proposal.

## Proposed components

| Component | Initial preview and spacing | Visual variants / states to show |
| --- | --- | --- |
| Button | Hug label, default height 32, small 28; padding 8×12, gap 8; radius 4. Icon-only 32×32. | Primary, secondary, ghost, destructive; default/small; default, hover, focus, disabled. Leading/trailing/icon-only arrangements. |
| Input | 280×36; padding 8×12, gap 8; radius 6. Label, helper and error sit outside the field. | Empty, filled, search with shortcut hint, error, focus, disabled. Error text wraps when necessary. |
| Badge & counter | Hug content; tag height 24, padding 4×8, gap 4; counter minimum 20×20; dot 6×6. | Counter, accent counter, status dot, tag; neutral/accent/success/warning/danger. Counts cap at 99+. |
| Nav item | 240×36; padding 8×12, gap 8; radius 4; optional count at right. | Inactive, active, hover, focus; nesting 0/1 with proposed 16px additional inset. Active uses a fill plus an indicator. |
| List row | 400×64; padding 12×16, gap 8; title and one-line snippet, trailing timestamp. | Read, unread, hover, focus. Unread has a leading dot and stronger title; snippet ellipsizes. |
| Empty state | 400 wide, auto height (about 180 for the supplied copy); padding 24, gap 8. | First run, caught up, blocked. Positive caught-up example has no action button. |
| Chart (area) | Default 400×240, padding 16, gap 12; sparkline 160×48. | Default, sparkline, stacked (maximum two series); accent/success/danger. Proposed 2px line and 12% fill opacity; sample series clearly marked illustrative. |
| Table | 640 wide, auto height; 36px header; comfortable rows 40, compact 32; cell horizontal padding 12. | Comfortable/compact; sortable header, selected rows, empty body. Numeric values right-aligned; optional selection column. |
| Dropdown | Menu 208 wide, auto height; padding 4; item minimum height 32, padding 8×12, gap 8; radius 6. Select trigger 240×36. | Menu/select; default, highlighted, selected, disabled, destructive entry. Group actions and separate destructive items. |
| Card | 320 wide, auto height (about 160 for a stat sample); padding 16, gap 12; radius 6. | Default, interactive, stat. Border-only; interactive uses Accent border. Optional header/footer separated by Line rules. |
| Tabs | Primary strip 320×36; item padding 8×12, gap 8; proposed active underline 2px. Secondary group hugs content. | Primary underline, secondary segmented; active, inactive, hover, focus, disabled. |
| Switch | Track 36×20, thumb 16×16 with 2px inset; labeled row minimum height 32, gap 8. | Off/on, focus, disabled. On uses Accent; label describes the on state. No separate save action. |
| Checkbox & radio | Visual control 16×16 inside minimum 24×24 target; labeled row height 32, gap 8. Checkbox radius 4; radio circular. | Checkbox unchecked/checked/indeterminate; radio selected/unselected; focus, disabled. Radio group has a visible group label. |
| Accordion | 400 wide; trigger minimum height 40, padding 12×16; content auto height, padding 0×16 plus 16 bottom. | Single/multiple; open, closed, focus, disabled. Whole trigger row is the target. |
| Dialog | 400 wide, auto height; padding 24, gap 16; radius 6; footer gap 8. | Standard decision and destructive confirmation. Cancel left, committing action right. Overlay, close policy and focus-return behavior documented separately. |
| Toast | 360 wide, minimum height 64, grows with content; padding 12×16, gap 8; radius 6. | Success/error/info; message only and message plus action. Never use color as the only status signal. |
| Amount input | 320 wide; 40px input with helper/balance below (about 64 total); padding 8×12, gap 8; radius 6. | Empty, filled, focus, insufficient balance, disabled; currency and precision represented as content properties. Value uses Mono. |
| Avatar | Default 32×32, proposed small 24 and large 40; circular. Group overlap 8. | Image, initials, group with +N after about four items. Keep sizes consistent within each context. |
| Alert / banner | 400 wide, auto height (about 80 for title and two lines); padding 12×16, gap 8; radius 6. | Info/warning/danger; optional action; dismissible only for nonblocking conditions. Signal indicator, readable text and explicit action. |
| Command palette | 480 wide; search 40 high; grouped results auto height up to a proposed 320px viewport; padding 8, gap 8; radius 6. | Empty query, filtered results, highlighted result, no results. Actions/Recent/Navigate groups; keyboard-hint footer. |
| Skeleton | Match the corresponding component exactly. Example list skeleton uses the 400×64 row rhythm. | List row, card and chart placeholders. Shape dimensions follow the target; motion is documented, not simulated as functional loading. |
| Tooltip | Hug content, proposed max width 240; padding 4×8; radius 4; Caption 12px. | Top/bottom/left/right, with and without shortcut hint. Ink 900 background, Paper 000 text. Focus and hover triggers documented. |
| Pagination | Hug content, minimum height 32; page targets 32×32, gap 4; summary separated by 12. | First, middle, last page; active, inactive, focus, disabled previous/next. Include the “Showing 1–10 of 42” summary. |

## Token mapping and additions requiring approval

Use the collection-scoped variables already created in Figma. Prefer IDs when
applying bindings so repeated names cannot bind to the wrong collection.

| Property | Existing variable |
| --- | --- |
| Primary interface text | Color / Ink 900 |
| Secondary text | Color / Ink 500 |
| Main surface | Color / Paper 000 |
| Borders and separators | Color / Line |
| Primary fill, active indicator and focus | Color / Accent |
| Error / warning / success indicator | Color / Signal/red, Signal/amber, Signal/green |
| Interface and data families | Typography / Family/UI, Family/Mono |
| Interface and data sizes | Typography / Size/Body, Size/Caption, Size/Mono, Size/Heading/16, Size/Heading/20, Size/Display |
| Padding, spacing and gaps | Spacing / 4, 8, 12, 16, 24, 32, 48 |
| Shell panel radius / outer gutter | Spacing / Shell/radius, Shell/gutter |

Proposed additions: `Spacing / Radius/control = 4` and
`Spacing / Radius/container = 6` (FLOAT, Default mode). Other component-specific
dimensions are proposed literals for this first draft rather than an expanded
token taxonomy. No new colors, font weights or shadow tokens are proposed yet.

## Documentation and presentation

Each component should carry a concise Figma Description explaining its purpose
and behavior, drawn from the Markdown. Preserve its Do/Don't/accessibility
guidance in readable documentation, separately from visual specification data.

Example Switch Description:
“Immediate, self-contained on/off setting with no separate save step. The label
describes the on state. Use a checkbox in a form when a later save is required.”

Suggested presentation: a dedicated Rift Labs page with Foundations, Components
and Usage guidance sections. Label proposed values as draft. Keep masters and
variant examples grouped by component; never stack all previews at one origin.
Actual positioning and documentation-page creation still need an apply plan.

## Current implementation limits

This file is a visual review, not an executable or validated sync plan. Existing
raw MCP tools support basic component creation, auto layout, fill/numeric token
bindings, text, instance children and component sets. They do not yet provide the
combined Markdown resource plan/apply, documentation-page renderer or complete
mapping needed for every treatment above. Missing tool support must be identified
before applying; do not substitute empty rectangles for completed components.

Figma examples document keyboard handling, ARIA, responsive behavior, precision
validation and loading behavior; a static component does not implement these
runtime behaviors. shadcn/Base UI code import or installation is a separate task.

Approving this visual direction does not by itself approve arbitrary future
changes, installing dependencies, or overwriting existing design resources.
