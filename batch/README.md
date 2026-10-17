# elf-batch

Pushes a whole component library into Figma — tokens, then components in
dependency order, in small resumable chunks — through the Elf bridge. It talks
to the same local WebSocket lane as the MCP server (`/control`), so the Figma
plugin must be running in a file with the bridge connected.

Re-running is the normal workflow: only what changed is written, and nothing
is ever duplicated.

```
npm install                      # once
npm start -- --dry-run           # plan, touch nothing
npm start                        # for real
```

## The pipeline

1. **Tokens** — primitives (a `Primitives` collection, one `Value` mode), then
   semantic tokens, then text/effect styles. Variables are matched by codeKey
   (the full dotted path), so re-runs update in place.
2. **Components** — parsed from `.tsx`/`.astro` sources, ordered by their
   sibling imports (leaves first; a cycle is an error), then written in chunks
   (default 5). The manifest is saved after every chunk, so a crash resumes
   from the last completed chunk.
3. **Failures** — one bad component does not stop the run. Its dependents are
   skipped, everything else proceeds, and the summary lists every failure with
   its reason. A failed token phase aborts before any component.

## Config — `elf-batch.config.json`

```json
{
  "tokens": "tokens.json",
  "components": "src/components",
  "manifest": "elf.manifest.json",
  "modeStrategy": "modes",
  "semanticModes": ["Light", "Dark"],
  "chunkSize": 5,
  "collections": { "primitives": "Primitives", "semantic": "Semantic" }
}
```

Paths resolve relative to the config file. Only `tokens` and `components` are
required. `modeStrategy: "collections"` turns Light/Dark into two single-mode
collections (`Semantic Light`, `Semantic Dark`) instead of one multi-mode
collection — use it when your Figma plan allows only one mode per collection.

## Tokens — `tokens.json`

Primitives are nested groups whose leaves carry `value` + `type`
(`color`, `dimension`, `fontSizes`, `fontFamilies`). Dotted paths become
`/`-separated Figma names; the dotted path is the codeKey.

```json
{
  "color": { "primary": { "500": { "value": "#6366f1", "type": "color" } } },
  "space": { "4": { "value": 16, "type": "dimension" } },
  "fontFamily": { "sans": { "value": "Inter", "type": "fontFamilies" } },
  "fontSize": { "body": { "value": 14, "type": "fontSizes" } },
  "semantic": {
    "color": {
      "surface": {
        "value": "{color.surface.base}",
        "modes": { "Dark": "{color.onSurface.base}" }
      },
      "text": { "value": "{color.onSurface.base}" }
    }
  },
  "textStyles": {
    "Body/Regular": { "fontFamily": "{fontFamily.sans}", "fontSize": "{fontSize.body}" }
  },
  "effectStyles": {
    "Elevation/1": { "effects": [{ "type": "DROP_SHADOW", "color": "#00000040", "offset": { "x": 0, "y": 2 }, "radius": 4 }] }
  }
}
```

Semantic Figma names drop the `semantic.` prefix (`semantic.color.surface` →
`color/surface`) so they sit next to their primitive group. `{…}` references
(braces optional) become variable aliases; only `text.characters`, `fontStyle`
and effect definitions are typed literally.

## Components — `<Name>.figma.json` sidecars

Any component file works: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro` — one
component per file, file name = component name. Every component needs a
sidecar next to it (`Button.tsx` → `Button.figma.json`). Design fields
reference tokens by dotted path; numbers are literals.

```json
{
  "layoutMode": "HORIZONTAL",
  "padding": { "all": "space.4" },
  "gap": "space.2",
  "cornerRadius": "radius.md",
  "fill": "color.primary.500",
  "stroke": { "color": "color.line.inputSoft", "weight": 1 },
  "size": { "width": 120, "height": 40 },
  "text": { "characters": "Continue", "fontSize": "fontSize.body", "color": "color.onSurface.base" },
  "children": [{ "type": "instance", "component": "Icon.tsx#Icon" }],
  "variants": {
    "size=sm, intent=primary": { "padding": { "all": "space.2" } }
  }
}
```

- Variant props are read from string-literal unions on the props type
  (`size?: "sm" | "md"`); components with any become Figma component sets,
  one variant per combination. Works the same in React/Astro
  (`interface Props`), Vue (`defineProps<Props>()`, including inline
  `defineProps<{ … }>()`), and Svelte (`interface Props`; Svelte 4
  `export let tone: "on" | "off"`). Variant labels in the sidecar must match
  (`"size=sm, intent=primary"`).
- `children` instantiate other components by codeKey (`<file>#<Name>`). The
  slots are replaced wholesale each sync when the list is present; omit the
  field to leave existing children untouched.
- Unknown sidecar fields are errors, not warnings.

## Manifest — `elf.manifest.json`

Tracked per component (`figmaNodeId`, `specHash`, `status`, `updatedAt`,
`error`) and per token (`figmaVariableId`, `valueHash`). It is written
atomically after every chunk. A component is skipped only when it is `synced`
and its spec hash is unchanged — delete the file (or entries) to force
re-sync, or use `--force`. Commit it: it is what makes re-runs and crash
resumes cheap.

## Flags

| Flag | Effect |
| --- | --- |
| `--config <path>` | Config file (default `elf-batch.config.json`) |
| `--dry-run` | Plan and report; no bridge call, no manifest, no writes |
| `--only <name>` | One component (name or codeKey) plus its dependencies |
| `--chunk <n>` | Components per chunk (default: config `chunkSize`) |
| `--resume` | Skip unchanged components (the default) |
| `--force` | Ignore hashes: re-write everything |

## Manual checklist (requires real Figma)

Everything in `npm test` runs against a fake bridge; the Figma side is
verified by hand:

- [ ] `--dry-run` against a real file: counts match what `--only` then writes.
- [ ] Run twice: second run reports `unchanged` everywhere except styles, and
      Figma gains no duplicate variables, styles or components.
- [ ] A component set with per-variant overrides: variants get the overrides,
      the set updates in place on re-run.
- [ ] Changing the variant roster (add a value to a union) rebuilds the set —
      existing instances detach (known Figma behavior, intentional).
- [ ] `children` slots: instances appear inside plain components and sets; a
      re-run with a shorter list removes the extra children.
- [ ] Kill the run mid-way (Ctrl-C): re-run picks up from the last chunk.
- [ ] Break one sidecar: that component fails, its dependents are skipped,
      the rest of the library still syncs.

## Known limitations

- One component per file; the component name must match the file name.
  Supported extensions: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro` — keep
  helper modules outside the components folder.
- Variant props must be string-literal unions on `Props`/`<Name>Props` — a
  plain `.jsx` component (no type annotations) has no variant props.
- Vue `defineProps([…])` (array form) carries no literal unions and is treated
  as variant-less.
- Semantic tokens may reference primitives or earlier-defined semantic tokens
  (no forward or circular references).
- Text/effect styles re-upsert every run; they are not in the manifest.
- Token-driven `layoutMode` and per-variant children set changes rebuild
  rather than diff.
