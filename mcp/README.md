# Local Figma MCP — variables & basic components

An MCP server that lets Cursor/Claude **read and write Figma variables and basic components** through
the Figma **Plugin API**. It never touches the REST Variables API — that one is Enterprise-only — so
this works on a **free or Professional** plan.

```
┌──────────────┐  stdio   ┌──────────────┐  ws://127.0.0.1:8765   ┌─────────────────┐  postMessage  ┌──────────────┐
│ Cursor /     │ ◄───────► │  mcp/ server │ ◄────────────────────► │  bridge-plugin │ ◄────────────► │ plugin main  │
│ Claude       │   JSON-RPC│  (Node)      │        JSON envelopes   │  UI iframe     │               │ Plugin API   │
└──────────────┘           └──────────────┘                        └─────────────────┘               └──────────────┘
```

The plugin main thread cannot open sockets, so the **UI iframe holds the WebSocket** and relays
messages to the main thread over `postMessage`. Every request carries an `id`; every response returns
that `id` plus `ok`/`error`. The bridge binds to `127.0.0.1` only and requires a shared token in the
handshake.

---

## Setup

### 1. Install

```bash
cd mcp
npm install
```

The MCP server is its own package — it has no effect on the root `elf-tokens` install.

### 2. Create a token

```bash
export ELF_MCP_TOKEN=$(openssl rand -hex 24)     # min 8 chars; keep it out of git
```

Or put it in `mcp/.env` — the server loads that file automatically at startup; real environment
variables win over it:

```bash
cp .env.example .env && $EDITOR .env
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ELF_MCP_TOKEN` | *(required)* | Shared secret in the WebSocket handshake. Never logged; only a sha256 fingerprint is printed at startup. |
| `ELF_MCP_PORT` | `8765` | Loopback port for the bridge. If you change it, also set it in the plugin's host field and in `bridge-plugin/manifest.json`. |
| `ELF_MCP_HTTP_PORT` | `8788` | Port for the Streamable HTTP transport (`npm run start:http`). Tunnel this port for web clients. |
| `ELF_MCP_TIMEOUT_MS` | `10000` | Per-request timeout. |

The server refuses to start without a token, so a stray bridge is never open to the network.

### 3. Build the plugin

```bash
npm run build:bridge-plugin      # writes bridge-plugin/code.js from code.ts
```

### 4. Load it in Figma

1. **Plugins → Development → New plugin → Link existing plugin** → pick `bridge-plugin/manifest.json`.
2. Open the plugin panel, paste the same token into **Bridge token** (leave the host at
   `localhost:8765` unless you changed it — see below for tunnels), press **Connect**.
3. The pill turns green and reads `connected · localhost:8765`. The token is kept in
   `figma.clientStorage` (per machine, per plugin) — it is **not** written into the Figma document.

The host field also accepts a full URL: `https://…` connects over `wss://` (e.g. an ngrok tunnel,
see below), `http://…` over `ws://`. The bridge itself always binds to `127.0.0.1` and the manifest
always declares `ws://localhost:8765` for local use — **use `localhost`, not `127.0.0.1`**: Figma's
manifest validator rejects raw IPs (`127.0.0.1` fails with "should be a valid URL"), while
`localhost` is a permitted dev domain.

### Optional: reach the bridge through an ngrok tunnel

Use this only if Figma cannot reach `localhost` directly (rare) — for example a managed machine
where the plugin's iframe can't open plain `ws://` sockets. The bridge stays on your machine;
ngrok just gives Figma's sandbox a `wss://` URL to connect to.

```bash
ngrok http 8765        # note the https://….ngrok-free.app URL it prints
```

Paste that URL into the plugin's **Bridge host** field (`https://…` becomes `wss://`
automatically) and press **Connect**. `bridge-plugin/manifest.json` already declares
`wss://*.ngrok-free.app`, so any free ngrok tunnel works without editing the manifest. Free-plan
hostnames change on every restart — just paste the new one into the panel again.

Security notes: the tunnel URL is public, so the token is the only gate — keep it long
(`openssl rand -hex 24`) and stop the tunnel (`Ctrl-C`) when you're done. If the tunnel answers
with ngrok's HTML interstitial instead of upgrading the socket, the connection fails immediately
with a closed socket — reload the panel once; if it persists, that tunnel is behind a warning page
your plugin can't clear, and `localhost` (or a paid ngrok domain) is the way around it.

If you change the local port, put the same value in the panel's host field
(`localhost:<port>`) and update `devAllowedDomains` in `bridge-plugin/manifest.json` to match.

### 5. Add it to your MCP client

Cursor / Claude Desktop (`~/.cursor/mcp.json` or `claude_desktop_config.json`):

```jsonc
{
  "mcpServers": {
    "elf-figma": {
      "command": "/absolute/path/to/elf/mcp/node_modules/.bin/tsx",
      "args": ["/absolute/path/to/elf/mcp/src/index.ts"],
      "env": { "ELF_MCP_TOKEN": "the-same-token-you-pasted-into-figma" }
    }
  }
}
```

Use absolute paths — the client may start the process from any directory. On macOS the `tsx` binary is
a symlink; if your client won't run it, use `{"command": "npm", "args": ["--prefix", "/abs/path/mcp", "run", "start"]}`
instead.

Restart the client, then ask it: *"call the elf-figma status tool"*.

### Web clients: Claude, Grok, ChatGPT

Web assistants can't spawn local processes and call your server **from their cloud**, so they need
the Streamable HTTP transport behind a public HTTPS URL. What the free plans allow (as of 2026):
**Claude** free gets one custom connector and supports authless servers ("No sign in"); **Grok**
free has custom MCP connectors at `grok.com/connectors`; **ChatGPT** free has no custom MCP — skip
it until you're on Plus.

```bash
cd mcp
npm run start:http          # stop any running `npm run start` first — both own the bridge port
ngrok http 8788             # keep this running next to it; note the https://….ngrok-free.app URL
```

Your connector URL is the tunnel URL **plus the token in the path** (web dialogs can't set custom
headers, so the token travels in the URL):

```
https://<something>.ngrok-free.app/t/<ELF_MCP_TOKEN>/mcp
```

- **Claude**: Settings → Customize → Connectors → *Add custom connector*, paste the URL, and under
  Authentication pick **No sign in** — the token is already in the URL.
- **Grok**: `grok.com/connectors` → *New Connector* → *Custom* → paste the URL (all plans; on
  Business/Enterprise an admin provisions it first).

Keep the Figma plugin connected to `localhost:8765` exactly as in the local setup — the tunnel only
exposes the MCP side, the plugin still talks to the bridge over loopback. Requests tunneled this way
are served statelessly, so there is nothing to reconnect after a tunnel restart.

Verify from your own machine first:

```bash
curl -s http://127.0.0.1:8788/mcp -d '{}' -o /dev/null -w '%{http_code}\n'    # 401 without the token
curl -s -X POST "https://<something>.ngrok-free.app/t/$ELF_MCP_TOKEN/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Security notes, since the endpoint is now public: the token in the URL is the only gate — treat the
connector URL as a secret, `.env` keeps it out of git, and the server answers 401 without it and
never logs the value (only a fingerprint). Stop the tunnel (`Ctrl-C`) when you're done, and rotate
the token by editing `.env` and re-adding the connector. Free ngrok hostnames change on every
restart; claim the free static domain (`ngrok http 8788 --domain=yours.ngrok-free.app`) so you don't
have to re-add the connector each time.

---

## Tools

Every tool answers with a JSON payload that always has `ok: true|false`. When the plugin isn't
connected, every tool except `status` fails with *"No Figma plugin connected — open the Elf Bridge
plugin in Figma…"*. Plan-limit errors from Figma come back **word for word**.

| Tool | What it does |
|---|---|
| `status` | Bridge state, port, and the file the plugin is attached to. Works with the panel closed. |
| `list_collections` | Local variable collections with modes, default mode and variable count. |
| `list_variables` | Variables, optionally filtered by collection and type; values per mode + stored `codeKey`. |
| `create_collection` | Create a collection (array of modes). Idempotent — re-running adds only missing modes. |
| `upsert_variables` | Create/update an **array** of variables, matched by name. |
| `rename_variable` | Rename by id or name; refuses to create a duplicate name. |
| `delete_variable` | Delete by **arrays** of ids and/or names; misses reported under `missing`. |
| `list_components` | Components under a parent (default: current page), with `codeKey`. |
| `upsert_component` | Create/update one component: auto layout, padding, gap, radius, fill, optional text child, instance slot children. |
| `upsert_component_set` | Create/update a component set from explicit variants (size × intent, …), styling the set and each variant. |
| `upsert_text_style` | Create/update a local text style (font, size, line height, letter spacing) — a Figma style, not a variable. |
| `upsert_effect_style` | Create/update a local effect style (shadows, blurs — e.g. elevation). |
| `get_node` | Read a node back — layout, fills, `boundVariables` — to verify a write. |

### Writes are upserts, and everything is tagged

Two runs of the same call **update** instead of duplicating: variables match on name inside a
collection, components match on `codeKey` first and name second. Everything touched comes back with its
Figma id.

Every created variable and component is tagged with
`setSharedPluginData("elf", "codeKey", <the codeKey you passed>)` — the hook for the code↔Figma
manifest later. `codeKey` is optional; when it is missing on an update the existing tag is kept.

### `upsert_variables`

`values` is keyed by **mode name or mode id**. `type` is inferred from the first value when omitted
(`#rrggbb` / `rgb(…)` / `{r,g,b}` → `COLOR`, number → `FLOAT`, boolean → `BOOLEAN`, string → `STRING`),
and `{"variable": "…"}` writes an alias. `mode` is the fallback for any value key that isn't a mode of
the collection. Per-item failures (immutable type, unknown mode) are reported in `errors` with the ids
of everything that did succeed — a failed item is never left half-written.

```jsonc
{
  "collection": "Core",
  "defaultMode": "Light",
  "variables": [
    { "name": "color/primary/500", "type": "COLOR", "codeKey": "primary-500",
      "values": { "Light": "#6366f1", "Dark": "rgb(79, 70, 229)" } },
    { "name": "space/4", "type": "FLOAT", "codeKey": "space-4",
      "scopes": ["WIDTH_HEIGHT", "GAP"], "values": { "Light": 16, "Dark": 20 } },
    { "name": "font/family/sans", "type": "STRING", "codeKey": "font-sans", "values": { "Light": "Inter" } },
    { "name": "color/primary/hover", "type": "COLOR", "codeKey": "primary-hover",
      "values": { "Light": { "variable": "color/primary/500" } } }
  ]
}
```

`create_collection` first:

```jsonc
{ "name": "Core", "modes": ["Light", "Dark"] }
```

→ `{ "ok": true, "collection": { "id": "VariableCollectionId:…", "modes": [ … ], "variableCount": 0 } }`

### `upsert_component`

Every number and the fill takes either a literal or `{"variable": "name"}` (FLOAT for
padding/gap/radius, COLOR for fill). Variables are resolved by id, by `collection/name`, or by an
exact name — an ambiguous name is an error that lists the candidates. Omitted properties are left
untouched. The optional `text` child is upserted in place, so repeated calls edit the same label rather
than stacking new ones.

```jsonc
{
  "name": "Button/Primary",
  "codeKey": "button-primary",
  "layoutMode": "HORIZONTAL",
  "padding": { "all": 12, "left": { "variable": "space/4" } },
  "gap": { "variable": "space/2" },
  "cornerRadius": { "variable": "radius/md" },
  "fill": { "variable": "color/surface/base", "color": "#ffffff" },
  "text": { "characters": "Continue", "fontFamily": "Inter", "fontStyle": "Regular", "fontSize": 14 }
}
```

→ `{ "ok": true, "component": { "id": "12:34", "created": true, … }, "boundVariables": { "fills": { "variableName": "color/surface/base" }, … } }`

### Instance children

`children` turns a component into a slot host: each entry instantiates another component **by its
`codeKey`** (component sets instantiate their default variant). The whole slot list is rebuilt on
every call that provides `children` — omitting it leaves existing children alone, and a rejected call
never touches the slots. (Destructive by design: re-runs stay deterministic.)

```jsonc
{
  "name": "Card",
  "codeKey": "card",
  "layoutMode": "VERTICAL",
  "children": [
    { "type": "instance", "component": "card-graphic" },
    { "type": "instance", "component": "button" }
  ]
}
```

### `upsert_component_set`

Variants each name their property values; the first variant defines the property keys every other
variant must match (same keys, same order). Set-level styling fields apply to all variants, and a
variant's `spec` overrides them per variant. A matching roster updates the variants **in place**;
a changed roster rebuilds the set — Figma detaches instances of the old set when that happens.

```jsonc
{
  "name": "Button",
  "codeKey": "button",
  "layoutMode": "VERTICAL",
  "gap": 8,
  "padding": { "all": 12 },
  "variants": [
    { "props": { "size": "sm", "intent": "primary" }, "spec": { "padding": { "all": 8 }, "text": { "characters": "Go" } } },
    { "props": { "size": "sm", "intent": "secondary" }, "spec": { "padding": { "all": 8 } } },
    { "props": { "size": "md", "intent": "primary" } },
    { "props": { "size": "md", "intent": "secondary" } }
  ]
}
```

### Styles

`upsert_text_style` and `upsert_effect_style` manage **local Figma styles** (they show up in the
styles panel and can be applied to layers) — distinct from variables. Both upsert by `codeKey` first,
then name. Fonts are loaded before anything is written, so an unavailable family fails cleanly.
Effect style `effects` is the full list, replaced each call:

```jsonc
{
  "name": "Elevation/1",
  "codeKey": "elevation-1",
  "effects": [
    { "type": "DROP_SHADOW", "color": "#00000040", "offset": { "x": 0, "y": 2 }, "radius": 4, "spread": 0 }
  ]
}
```

---

## The `/control` lane (local processes)

There is a second local WebSocket path next to the plugin's: `/control`, same port, same token,
loopback only. It speaks plain JSON — `{ "type": "call", "id", "method", "params" }` in,
`{ "type": "result", "id", "ok", "result" | "error": { "message", "code" } }` back — so a script or
CLI can drive the bridge without speaking MCP. Control connections never disturb the plugin lane: a
client coming and going is invisible to Figma.

`mcp/src/client.ts` exports `createBridgeClient()` for exactly this; the `batch/` CLI is the first
consumer. Everything respects the same env (`ELF_MCP_PORT`, `ELF_MCP_TOKEN`, `ELF_MCP_TIMEOUT_MS`)
and the same error codes (`not-connected`, `timeout`, `auth`, `plugin`, …).

---

## Testing

```bash
cd mcp && npm test              # 59 unit tests: bridge, config, control client, variable/component tools
npm --prefix mcp run verify:plugin   # from the repo root
```

`npm test` runs a mock plugin over the **real** WebSocket server: request/response round trip and id
matching, timeout, not-connected error, bad-token rejection (close code `4001`), mid-flight
disconnect, verbatim plugin errors, upsert idempotency, the not-connected path for every tool, and
the `/control` client (round trips, auth/refusal messages, timeouts, bridge shutdown).

`verify:plugin` is the end-to-end check of the **real compiled plugin** (`bridge-plugin/code.js`)
without Figma: it loads the bundle against a stub `figma` global and drives it through the real
bridge, so requests, responses and error strings travel the production path. It proves mode
handling, per-mode values, aliases, rename/delete, codeKey tagging, component bindings, verbatim
plan-limit errors (`in addMode: Limited to 4 modes only`), component sets (build, update in place,
roster rebuild), instance slots, text/effect styles, and that a rejected upsert leaves nothing
half-created. Run it after every `npm run build:bridge-plugin`.

### Manual checklist (throwaway file, non-Enterprise plan)

Run through this once on a free/Professional account:

- [ ] **Load** — `Plugins → Development → Elf Bridge` opens; the pill shows `disconnected · 8765`.
- [ ] **Connect** — paste the token, press Connect, pill turns green and logs `connected`.
- [ ] **Status** — ask the client for `status`; it reports `connected: true` with the throwaway file's name and key.
- [ ] **Create a collection** — `create_collection { name: "Bridge Test", modes: ["Light", "Dark"] }`; the file gets a collection with exactly those two modes (not a leftover `Mode 1`).
- [ ] **Create 5 variables** — `upsert_variables` with two colors, two floats and one string; all five return ids and carry the `codeKey`.
- [ ] **Re-run the same call** — `created: 0`, `updated: 5`, and the file still holds five variables.
- [ ] **Check in Figma** — select each variable, look at its value per mode, and confirm the description/tag round trip (`codeKey` shows under *Plugins → Development → …* or via `list_variables`).
- [ ] **Bind a component fill** — `upsert_component` with `fill: { variable: "…/Light" }`; the component appears on the page with a literal fill *linked* to the variable (change the variable value in Figma and the component updates).
- [ ] **Re-run it** — same component id, `created: false`, and the label text updated in place.
- [ ] **Build a variant set** — `upsert_component_set` with 4 size × intent variants; Figma shows one component set with all 4 variants and their variant properties. Re-run: same set id, `created: false`.
- [ ] **Slot an instance** — `upsert_component` with `children: [{ "type": "instance", "component": "button" }]`; the component contains a real instance of the set (change the set and the instance follows). Re-run with an empty-ish list: no duplicated slots.
- [ ] **Create styles** — `upsert_text_style` and `upsert_effect_style`; both appear under *Local styles* in the Figma styles panel; re-running updates the same style entry.
- [ ] **Read back** — `get_node { nodeId }` reports the layout, the fill and `boundVariables`.
- [ ] **Delete** — `delete_variable { names: [...] }`; confirm the ids are gone and `missing` lists anything that didn't match.
- [ ] **Wrong token** — paste a different token, press Connect; the panel shows `auth failed` and the tools report not-connected. No token is ever printed in the panel or the server log.

---

## Limits and gotchas

- **Variables are local on non-Enterprise plans.** Creating, editing and using them in a local file
  works on every plan; *publishing* collections as a shared library does not. The REST Variables API
  stays off limits — that is the whole point of this approach.
- **Plan limits surface verbatim.** For example Figma's `in addMode: Limited to 4 modes only` is
  returned to the caller unchanged rather than hidden or retried.
- **Variable types are immutable.** Changing `COLOR` → `FLOAT` on an existing variable is reported as
  a per-item error; delete and recreate it instead.
- **One plugin connection at a time.** The newest connection wins and the previous one is closed with
  code `4002`; the panel stops retrying instead of fighting over the bridge.
- **Mixed content.** If your MCP client itself runs in a browser context that blocks `ws://`, run the
  server over stdio (as configured above) — the socket lives in Figma's panel, not in the client.
- **Text needs a real font.** `text.fontFamily` / `fontStyle` must exist in the file (default
  `Inter`); the font is loaded before any write, so an unavailable family leaves the component
  untouched.
- **`gap`/`padding` need auto layout** — pass `layoutMode: "HORIZONTAL" | "VERTICAL"` or the call is
  rejected before anything is created.
- **Component matching** is `codeKey` first, then name, searched inside the parent subtree. Two
  components with the same name in different frames stay separate as long as you pass `parentId`.

## Not in scope (yet)

Batch generation, drift diffing, the code↔Figma manifest file, GitLab, codebase parsing, and
anything that would require the Figma REST API.