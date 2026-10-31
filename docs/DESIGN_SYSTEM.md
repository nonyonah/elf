RL

Rift Labs

Design system · draft v0.1

[Introduction](#introduction)

Foundations

[Color](#color) [Typography](#typography) [Spacing](#spacing) [Iconography](#iconography) [App shell & sidebar](#appshell)

Components

[Button](#button) [Input](#input) [Badge & counter](#badge) [Nav item](#navitem) [List row](#listrow) [Empty state](#emptystate) [Chart (area)](#chart) [Table](#table) [Dropdown](#dropdown) [Card](#card) [Tabs](#tabs) [Switch](#switch) [Checkbox & radio](#checkboxradio) [Accordion](#accordion) [Dialog](#dialog) [Toast](#toast) [Amount input](#amountinput) [Avatar](#avatar) [Alert / banner](#alertbanner) [Command palette](#commandpalette) [Skeleton](#skeleton) [Tooltip](#tooltip) [Pagination](#pagination)

Rift Labs · Design System

# A starting point, not a finished system

This draft sets up the foundations and first six components for Hedwig and Dobby's shared product surface — no components exist yet, so this is meant to be argued with, not shipped as-is.

Palette and tone are drawn from the workspace tooling Rift Labs already uses day to day: a dark, quiet sidebar; a plain-paper content area; hairline borders instead of shadows; and restrained, outline-only icons. Nothing here is pushed anywhere yet — treat every value as a proposal.

**Stack:** built on shadcn/ui, themed as "Mira," sitting on top of Base UI as the unstyled, accessible primitive layer underneath — Base UI supplies keyboard handling, focus management, and ARIA wiring; shadcn and the Mira theme supply the visual layer described in this document. Primary typeface is Inter.

## Color

A small, named palette. Ink for structural chrome, paper for content surfaces, one accent for interactive state, and three signal colors reserved for meaning rather than decoration.

Ink 900

#17181c

Ink 700

#2b2d33

Ink 500

#6b6d72

Paper 000

#faf9f7

Line

#e0ddd7

Accent

#4a55c9

Signal · amber

#ad7f22

Signal · red

#b0402f

Signal · green

#35754e

Contrast rule

- Body text on Paper 000 or white must hold 4.5:1 minimum — Ink 900 and Ink 500 both pass; do not lighten Ink 500 further for "secondary" text.
- The three signal colors are for status only, and every status is backed by an icon or label — never color alone.

## Typography

One family for everything a person reads, one monospace family reserved for values, code, and data labels.

Inter — UI & content

Display / 26Payouts are on the way

Heading / 20Weekly summary

Heading / 16Recent transactions

Body / 14Freelancers get paid in stablecoins, instantly.

Caption / 12Last updated 2 minutes ago

JetBrains Mono — values & data

Mono / 13$1,204.50 USDC

## Spacing

An 8px base scale, with 4px available for tight, single-line contexts like a badge or icon gap.

4

8

12

16

24

32

48

## Iconography

Phosphor Icons, regular weight, is the primary set — 1.5px stroke on a 24px grid so weight matches nearby type. Hugeicons is an accepted second source when Phosphor is missing a glyph, matched to the same stroke weight and grid so the two don't visually clash. No filled icons except the single active-state dot used in navigation and unread indicators.

Do

- Use one stroke weight across the whole product, whichever library a glyph comes from.
- Pick icons for recognizability over cleverness — a plain envelope over an abstract mail glyph.

Don't

- Mix outline and filled icon sets in the same view.
- Introduce a new icon for a concept that already has one.

## App shell & sidebar

The window background is one flat surface. The sidebar sits directly on it with no card, border, or fill of its own — it recedes into the background on purpose. The app shell, the main working surface, is the one thing that's visually lifted: a rounded, shadowed panel inset from the sidebar and the window edges.

Home

Inbox

Activity

Settings

Overview

The demo above is scaled down and rounded on its own outer edge only for presentation — in the real window, the outer background is the full, unrounded viewport. Only the shell panel carries the 12px radius.

| Token | Value | Notes |
| --- | --- | --- |
| Shell radius | `12px` | Fixed — doesn't vary by screen or breakpoint. |
| Shell gutter | `8px` | Space between the shell panel and the sidebar, and between the panel and the window's other edges. |
| Sidebar fill | none | Sidebar items sit straight on the window background — no container surface. |

Do

- Keep the sidebar visually quiet — no border or fill — so the elevated shell reads as the one surface in focus.
- Keep the 12px radius and the gutter identical on every screen the shell appears on.

Don't

- Give the sidebar its own card treatment (border, shadow) — it competes with the shell for visual priority.
- Let the shell touch the window edge — the gutter is what sells the floating effect.

Accessibility

- The sidebar is still a real landmark (`<nav aria-label="Primary">`) even with no visual container; the shell panel is the `<main>` landmark.
- Rounding and shadow are decorative only — document structure and reading order stay the same regardless of the visual treatment.

## Components

Six starting components, chosen because they cover navigation, input, status, and the two states — full and empty — that every list-based screen needs.

### Button

The single mechanism for triggering an action. Weight (primary → destructive) signals how much attention the action deserves.

Create issue Cancel Skip Delete workspace ⚙ Save Archived

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | primary \| secondary \| ghost \| destructive | Exactly one primary button per screen. |
| `size` | default \| small | Small is for dense toolbars and table rows only. |
| `icon` | leading \| trailing \| only | `icon="only"` requires `aria-label`. |
| `disabled` | boolean | Pair with a tooltip explaining why, when the reason isn't obvious. |

Do

- Name the button after what happens: "Delete workspace," not "Confirm."
- Keep destructive actions behind a second confirming step.

Don't

- Use two primary buttons side by side.
- Use ghost style for the main action on a page.

Accessibility

- Minimum 24×24px hit target, achieved through padding even when the visual button is smaller.
- Visible focus ring: 2px accent outline, 2px offset, never removed.
- Icon-only buttons always carry `aria-label`; decorative icons inside labeled buttons get `aria-hidden="true"`.

### Input

Text entry and search. Search fields in persistent chrome show a keyboard shortcut hint; form fields inside a flow do not.

Default

Search issues⌘K

Error

jane@

| Prop | Type | Notes |
| --- | --- | --- |
| `leadingIcon` | icon | Optional; used for search and filter fields. |
| `trailingHint` | string | Reserved for global-scope shortcuts, not per-field hints. |
| `error` | string | Renders below the field; also sets the invalid state. |

Do

- Pair every field with a real or visually-hidden label.
- Keep helper and error text to one line.

Don't

- Use placeholder text as the only label.
- Show an error before the person has finished typing.

Accessibility

- Label association via `<label for>` or `aria-labelledby` — never label-by-proximity alone.
- Error state sets `aria-invalid="true"` and `aria-describedby` pointing at the message.

### Badge & counter

Counters show an unseen total in navigation; dots show state on a row; tag badges label a category.

Counter3 Counter · accent12 Status dot TagHedwig

| Prop | Type | Notes |
| --- | --- | --- |
| `value` | number \| text | Cap displayed counts (e.g. "99+") rather than let them overflow. |
| `tone` | neutral \| accent \| success \| warning \| danger | Tone carries meaning — never purely decorative. |

Do

- Give every count an `aria-label` like "3 unread," not just the digit.

Don't

- Use color as the only signal between tones — pair with an icon or word where the state matters.

### Nav item

Primary navigation inside a workspace. Icon and label always travel together — never icon-only in this context.

Inbox 1

Reviews

My issues

Workspace

Projects

| Prop | Type | Notes |
| --- | --- | --- |
| `active` | boolean | Shown with a background fill, never text color alone. |
| `count` | number | Right-aligned, muted — reserved for unread or pending totals. |
| `nestingLevel` | 0 \| 1 | Do not go past one level of nesting. |

Accessibility

- The active item carries `aria-current="page"`.
- Nav items are a real `<ul>`/`<li>` list, not styled `<div>`s.

### List row

Any scannable list — inbox, transactions, notifications — where someone compares many items at a glance.

Payout received

$420.00 USDC landed in your Hedwig balance

2m

Invoice #0192 paid

Client confirmed payment via Dobby

1d

| Prop | Type | Notes |
| --- | --- | --- |
| `unread` | boolean | Bold title plus a leading dot — never bold alone. |
| `snippet` | string | Truncates with ellipsis; row height stays fixed. |

Do

- Make the whole row one focusable target unless it holds a separate control like a checkbox.

Don't

- Let snippet text wrap — it breaks row-height rhythm across the list.

Accessibility

- Unread rows expose an `aria-label` prefix such as "Unread: Payout received."

### Empty state

Replaces a bare blank screen when a list has zero items — first run, cleared, or blocked.

You're all caught up

New activity will show up here.

Do

- Write from what happens next: "You're all caught up," not "No notifications."

Don't

- Add a call-to-action to a positive empty state — inbox-zero needs no button.

Accessibility

- The illustration is decorative (`aria-hidden="true"`); the heading carries the actual meaning for screen readers.

### Chart (area)

The only chart type in this system for now. Reserved for a value trending over time — balance, volume, activity — where the filled region is what communicates magnitude, not for comparing unrelated categories.

Default — single series

Hedwig balance, 30 days $18,420.10

Sparkline — compact, no axes

Weekly volume

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | default \| sparkline \| stacked | Sparkline drops axes and grid; stacked layers 2 series max. |
| `series` | array | One or two series per chart — more than that, split into separate charts. |
| `tone` | accent \| success \| danger | Matches the fill and line color; reserve danger for a genuine negative trend. |
| `showAxis` / `showGrid` | boolean | Both off for sparklines; both on for the default variant. |

Do

- Keep the fill translucent so the gridlines stay visible underneath.
- Set the current value in mono type next to the chart title, matching other data values in the system.

Don't

- Reach for this component to compare unrelated categories — that's not what an area fill communicates.
- Stack more than two series; it stops being readable as a filled shape.

Accessibility

- Every chart ships with a visually-hidden data table or a one-line summary ("Balance up 12% this month") — an SVG shape alone isn't readable by a screen reader.
- With two series, label each in a text legend rather than relying on line color to distinguish them.

### Table

For rows with three or more comparable attributes — use the List row component instead when a row only really has a title and one piece of metadata.

| Invoice | Status | Amount | Date |
| --- | --- | --- | --- |
| #0192 — Acme Co. | Paid | $1,204.50 | Sep 12 |
| #0193 — Northwind | Pending | $420.00 | Sep 15 |
| #0194 — Loom Ltd. | Overdue | $88.00 | Aug 30 |

| Prop | Type | Notes |
| --- | --- | --- |
| `columns` | array | Numeric columns are right-aligned by default. |
| `sortable` | boolean per column | Sorted column shows a direction indicator in the header. |
| `selectable` | boolean | Adds a leading checkbox column; header checkbox selects all. |
| `density` | comfortable \| compact | Compact drops vertical padding for data-dense views. |
| `emptyState` | node | Renders the Empty state component in place of the body. |

Do

- Give the header row a distinct background, not just bold text — it needs to read as pinned in the sticky variant.
- Right-align every numeric column, including dates written as numbers.

Don't

- Make the whole row a click target if it also has an inline action — that creates a nested interactive element.
- Use Table and List row for the same kind of data in different parts of the product.

Accessibility

- Real `<table>` markup with `<th scope="col">` — never a div grid styled to look like one.
- Sortable headers announce state with `aria-sort`; row checkboxes get an accessible name referencing the row ("Select row: Invoice #0192").

### Dropdown

Covers two Base UI primitives: a Menu for a set of actions attached to a trigger, and a Select for choosing one value from a fixed list.

Rename

Duplicate

Move to project

Delete

USDC ▾

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | menu \| select | Menu triggers an action; Select commits a value to a field. |
| `items` | array | Each item takes an optional icon, label, and `destructive` flag. |
| `selected` | value | Select only — trigger shows this value, not a placeholder, once set. |

Do

- Put destructive actions last, behind a separator.
- Match a Select's menu width to its trigger; let an action Menu size to its content instead.

Don't

- Pack more than \~8 flat items into one menu — group with separators instead.
- Override Base UI's built-in keyboard and focus handling for the primitive.

Accessibility

- Base UI's Menu and Select handle focus trapping, roving tabindex, and typeahead automatically — this is the one place a floating shadow is used, to signal it's layered above the page.
- Every item's accessible name matches its visible label; no icon-only entries without text.

### Card

A bordered container for related content. Three uses: a plain grouping surface, a clickable summary, and a single-stat headline.

Payout schedule

Runs every Friday at 9:00 AM.

Invoice #0192

Accent border signals it opens on click.

$18,420.10

Balance, all accounts

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | default \| interactive \| stat | Interactive swaps the border to accent and becomes a real link or button. |
| `header` / `footer` | node | Optional slots, separated by a hairline rule, never a shadow. |

Do

- Keep cards border-only, matching the hairline language set in Foundations — no drop shadow on embedded cards.

Don't

- Stack a card inside another card — flatten the hierarchy with spacing or a divider instead.

Accessibility

- An interactive card is a single semantic link or button, not a `div` with an onClick and no role; a stat card exposes value and label as one readable string, e.g. "Balance, all accounts: $18,420.10."

### Tabs

Two designs: primary tabs switch between full page-level views; secondary tabs switch a scoped region without changing the page.

Primary

Overview Activity Settings

Secondary

7d 30d 90d

| Prop | Type | Notes |
| --- | --- | --- |
| `variant` | primary \| secondary | Primary uses an underline indicator; secondary uses a segmented pill. |
| `items` | array | Keep labels to one or two words. |

Do

- Move the active indicator with a quick transition rather than an instant jump.

Don't

- Use tabs for a plain on/off choice — that's the Switch component's job.

Accessibility

- Base UI's Tabs primitive wires up `role="tablist"`/`tab`/`tabpanel` and arrow-key navigation; only the active tab sits in the natural tab order, so don't add extra `tabindex` overrides on the panels.

### Switch

An immediate, self-contained on/off setting — it takes effect the moment it's toggled, with no separate save step.

Email receipts on Two-factor login

| Prop | Type | Notes |
| --- | --- | --- |
| `checked` | boolean |  |
| `label` | string | Describes the "on" state directly, not a generic "Enabled." |

Do

- Word the label as the state when it's on: "Email receipts on," not "Receipts."

Don't

- Use a switch for a setting that needs a follow-up confirm or save — use a Checkbox in a form instead.

Accessibility

- Base UI's Switch exposes `role="switch"` and the checked state automatically; the visible label is always clickable and toggles the switch too.

### Checkbox & radio

Checkbox for zero-to-many selections; radio for exactly one choice from a small, fully visible set of options.

Row selected Some rows selected Unselected Weekly Monthly

| Prop | Type | Notes |
| --- | --- | --- |
| `checked` / `indeterminate` | boolean | Indeterminate only applies to checkboxes representing a partial group selection. |
| `options` / `value` | array / value | Radio group only — always rendered under a shared, visible group label. |

Do

- Give every radio group a visible heading naming the decision being made.
- Use radios (not a Select) when there are five or fewer options and screen space allows.

Don't

- Use one lone checkbox as a stand-in for an immediate-effect yes/no setting — that's the Switch's job.

Accessibility

- Base UI's Checkbox and RadioGroup manage the indeterminate ARIA state and roving tabindex across a group; wrap every radio set in a `fieldset`/`legend` or equivalent `aria-labelledby`.

### Accordion

Progressive disclosure for secondary content the person doesn't need immediately — never the primary content on a screen.

How do payouts settle? ▾

Payouts settle on-chain within a few minutes of being sent.

Can I change my payout currency? ▸

| Prop | Type | Notes |
| --- | --- | --- |
| `type` | single \| multiple | Single closes other panels when one opens; multiple allows several open at once. |
| `items` | array | Each item's trigger text should stand alone when collapsed. |

Do

- Write trigger text that's fully meaningful on its own, since it's all that's visible when closed.

Don't

- Hide frequently-needed, primary content behind an accordion — reserve it for genuinely optional detail.

Accessibility

- Base UI's Accordion wires up `aria-expanded` and the header/region relationship; the entire header row is the clickable and focusable target, not just the chevron.

### Dialog

An interruption reserved for decisions that need a deliberate, in-the-moment answer — most often the confirming step a destructive Button already promises.

#### Delete workspace?

This removes all projects and can't be undone.

Cancel Delete workspace

| Prop | Type | Notes |
| --- | --- | --- |
| `title` / `description` | string | Description states the consequence in one sentence. |
| `dismissible` | boolean | Off for irreversible confirmations — no click-outside or Escape close. |

Do

- Put Cancel on the left, the committing action on the right, in that order every time.

Don't

- Reach for a dialog to confirm something low-stakes and reversible — a Toast with an Undo action is lighter and just as safe.

Accessibility

- Base UI's Dialog traps focus, sets `aria-modal="true"`, and returns focus to the trigger on close; the visible title is the dialog's accessible name.

### Toast

A brief, self-dismissing confirmation for something that already happened — a payout landing, an invoice getting paid.

Payout of $420.00 sent Transfer failed Retry

| Prop | Type | Notes |
| --- | --- | --- |
| `tone` | success \| error \| info | Always paired with a dot or icon, never color alone. |
| `action` | string | Extends the auto-dismiss duration when present. |

Do

- Keep the message to one line.

Don't

- Make a toast the only place to reverse something that matters — pair its action with a persisted way to find it later too.

Accessibility

- Toasts render in an `aria-live="polite"` region so they announce without interrupting whatever the person is doing.

### Amount input

Money entry, specifically — distinct from the plain text Input because precision, asset, and available balance all have to be visible at once.

$420.00USDC

Available: $1,204.50

| Prop | Type | Notes |
| --- | --- | --- |
| `currency` / `precision` | string / number | Decimal places are fixed to the chosen asset — the field refuses more. |
| `balanceHint` | string | Shown whenever the balance actually constrains the input. |

Do

- Set the numeric value in mono type, matching every other value in the system.

Don't

- Let someone type past the asset's real decimal precision.

Accessibility

- The currency symbol and asset are part of the field's accessible description, not decoration visible only on screen; an insufficient-balance error follows the same `aria-invalid`/`aria-describedby` pattern as Input.

### Avatar

Represents a person or business — a client, a team member, a merchant — anywhere the product needs a face rather than just a name.

JD AC JD AC +3

| Prop | Type | Notes |
| --- | --- | --- |
| `src` / `initials` | string | Initials render on a solid fill whenever there's no image. |
| `max` | number | Group only — collapse to a "+N" chip past this many. |

Do

- Keep every avatar in one context the same size.

Don't

- Show more than about four avatars before collapsing the rest into an overflow chip.

Accessibility

- An image avatar carries real `alt` text naming the person; an initials-only avatar still gets an `aria-label` with the full name, not just the two letters.

### Alert / banner

Page-level, persistent messaging — the pattern already used for the notes throughout this document. Different from a Toast because it doesn't go away on its own.

New featureRecurring invoices are now available for Hedwig accounts.

Action neededVerify your business details to enable payouts.

Payouts pausedWe couldn't confirm your bank details. Update them to resume.

| Prop | Type | Notes |
| --- | --- | --- |
| `tone` | info \| warning \| danger | Danger is reserved for something actually blocking. |
| `dismissible` | boolean | Off whenever the person must act before the banner's condition can go away on its own. |

Do

- State the action required, not just the problem: "Verify your business details," not "KYC incomplete."

Don't

- Make a blocking banner dismissible — that just hides the reason payouts are paused.

Accessibility

- `role="status"` for info; `role="alert"` for warning and danger so they're announced immediately rather than waited on.

### Command palette

What the ⌘K hint on the persistent Search field actually opens — search and act on anything in the product without leaving the keyboard.

Search or run a command…

Actions

Create invoice

Send payout

Recent

Invoice #0192

↑↓ navigate↵ selectesc close

| Prop | Type | Notes |
| --- | --- | --- |
| `groups` | array | Results are grouped (Actions, Recent, Navigate), never one flat list. |

Do

- Surface the most likely action first, based on where the person already is.

Don't

- Add a second, separate trigger elsewhere — ⌘K on the global Search field is the one entry point.

Accessibility

- Combobox pattern with `aria-activedescendant` tracking the highlighted result; typing to filter never moves focus out of the input.

### Skeleton

A placeholder shaped exactly like the content it stands in for, while a balance, list, or chart is still loading.

| Prop | Type | Notes |
| --- | --- | --- |
| `shape` | matches target component | Same row height and card padding as the real content. |

Do

- Match the skeleton's shape exactly to what's about to replace it, so nothing shifts on load.

Don't

- Show a skeleton for anything that resolves in under roughly 300ms — it reads as more broken than an instant swap. Any shimmer motion respects `prefers-reduced-motion`.

Accessibility

- The loading region carries `aria-busy="true"` with a visually-hidden "Loading" label; the skeleton shapes themselves are `aria-hidden`, since they carry no real content.

### Tooltip

Required on every icon-only Button, per that component's own accessibility note — this is the piece that actually delivers it.

Filter F

| Prop | Type | Notes |
| --- | --- | --- |
| `content` | string | The label, plus a shortcut hint when one exists. |
| `side` | top \| bottom \| left \| right | Defaults to top; flips automatically near a window edge. |

Do

- Use it only to surface information that isn't otherwise visible, like a shortcut.

Don't

- Put anything required to complete a task only in a tooltip.

Accessibility

- Base UI's Tooltip ties itself to the trigger via `aria-describedby` and appears on keyboard focus as well as hover — never hover alone.

### Pagination

Pairs with the Table component once a list is long enough to split across pages.

Showing 1–10 of 42 ‹ 1 2 3 ›

| Prop | Type | Notes |
| --- | --- | --- |
| `page` / `totalPages` | number |  |

Do

- Pair the page numbers with a plain-language count, so position is clear either way.

Don't

- Use numbered pagination on an unbounded, streaming list — that calls for a "Load more" pattern instead, not yet in this system.

Accessibility

- The current page carries `aria-current="page"`; prev/next disable rather than disappear at the ends, so the layout doesn't shift.

Draft v0.1 — Rift Labs design system. Nothing here is final; open to changing any token, component, or rule above.