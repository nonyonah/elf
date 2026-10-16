#!/usr/bin/env node
/**
 * End-to-end check of the compiled bridge plugin without Figma.
 *
 * Loads `bridge-plugin/code.js` with a stub `figma` global, lets it talk to the
 * real WebSocket bridge exactly like the UI iframe does, and drives it the way
 * the MCP server does. Every request, response and error string therefore
 * travels the production path — only Figma itself is simulated.
 *
 *   cd mcp && npm run verify:plugin                 # uses ../bridge-plugin/code.js
 *   cd mcp && npm run verify:plugin -- path/to/code.js
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.ts";

const TOKEN = "verify-plugin-local-token"; // loopback-only throwaway
const codePath = resolve(process.argv[2] ?? "../bridge-plugin/code.js");

let failures = 0;
let checks = 0;

async function check(label, run) {
  checks += 1;
  try {
    const detail = await run();
    console.log(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${label} — ${error.message}`);
  }
}

async function waitFor(condition, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// A figma global just good enough for the plugin.
// ---------------------------------------------------------------------------

function createFigmaStub(sendToSocket) {
  let counter = 0;
  const nextId = (prefix) => `${prefix}:${++counter}`;
  const registry = new Map();
  const collections = [];
  const variables = [];
  const storage = new Map();

  const pluginData = () => {
    const data = new Map();
    return {
      getSharedPluginData: (namespace, key) => data.get(`${namespace}/${key}`) ?? "",
      setSharedPluginData: (namespace, key, value) => {
        data.set(`${namespace}/${key}`, String(value));
      },
    };
  };

  const boundVariableApi = () => ({
    boundVariables: {},
    setBoundVariable(field, variable) {
      if (variable) this.boundVariables[field] = { type: "VARIABLE_ALIAS", id: variable.id };
      else delete this.boundVariables[field];
    },
  });

  const register = (node) => {
    registry.set(node.id, node);
    return node;
  };

  const childrenMixin = () => ({
    parentId: null,
    children: [],
    appendChild(node) {
      node.parentId = this.id;
      this.children.push(node);
      registry.set(node.id, node);
      return node;
    },
  });

  const page = register({ id: "0:0", name: "Page 1", type: "PAGE", ...pluginData(), ...childrenMixin() });

  const createComponent = () =>
    register({
      id: nextId("CO"),
      name: "Component",
      type: "COMPONENT",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      fills: [],
      layoutMode: "NONE",
      itemSpacing: 0,
      cornerRadius: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      ...pluginData(),
      ...boundVariableApi(),
      ...childrenMixin(),
      resize(width, height) {
        this.width = width;
        this.height = height;
      },
    });

  const createText = () =>
    register({
      id: nextId("TE"),
      name: "Text",
      type: "TEXT",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      fills: [],
      fontName: { family: "Inter", style: "Regular" },
      characters: "",
      fontSize: 12,
      ...pluginData(),
      ...boundVariableApi(),
    });

  const createVariableCollection = (name) => {
    const collection = {
      id: nextId("VC"),
      name,
      key: null,
      modes: [{ modeId: "m1", name: "Mode 1" }],
      defaultModeId: "m1",
      variableIds: [],
      renameMode(modeId, newName) {
        const mode = this.modes.find((candidate) => candidate.modeId === modeId);
        if (!mode) throw new Error(`Mode ${modeId} not found.`);
        mode.name = newName;
      },
      addMode(modeName) {
        // Mirrors the plan limit so the verbatim-relay path is exercised.
        if (this.modes.length >= 4) throw new Error("in addMode: Limited to 4 modes only");
        const mode = { modeId: nextId("M"), name: modeName };
        this.modes.push(mode);
        return mode.modeId;
      },
    };
    collections.push(collection);
    return collection;
  };

  return {
    mixed: Symbol("figma.mixed"),
    root: { name: "Throwaway", children: [page] },
    currentPage: page,
    fileKey: "throwawaykey",
    apiVersion: "1.0.0",
    showUI: () => {},
    ui: {
      onmessage: null,
      postMessage: (message) => {
        // The UI iframe forwards responses to the socket and ignores the rest.
        if (message.type === "response") sendToSocket(message);
      },
    },
    clientStorage: {
      getAsync: async (key) => storage.get(key),
      setAsync: async (key, value) => {
        storage.set(key, value);
      },
    },
    createComponent,
    createText,
    getNodeByIdAsync: async (id) => registry.get(id) ?? null,
    loadFontAsync: async ({ family, style }) => {
      if (family !== "Inter") throw new Error(`The font "${family} ${style}" could not be loaded.`);
    },
    variables: {
      createVariableCollection,
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async (type) => variables.filter((variable) => !type || variable.resolvedType === type),
      getVariableByIdAsync: async (id) => variables.find((variable) => variable.id === id) ?? null,
      createVariable(name, collection, resolvedType) {
        const variable = {
          id: nextId("VariableID"),
          name,
          resolvedType,
          variableCollectionId: collection.id,
          key: null,
          valuesByMode: {},
          setValueForMode(modeId, value) {
            this.valuesByMode[modeId] = value;
          },
          remove() {
            const index = variables.indexOf(this);
            if (index >= 0) variables.splice(index, 1);
            const collection = collections.find((candidate) => candidate.id === this.variableCollectionId);
            if (collection) {
              const listIndex = collection.variableIds.indexOf(this.id);
              if (listIndex >= 0) collection.variableIds.splice(listIndex, 1);
            }
          },
          ...pluginData(),
        };
        variables.push(variable);
        collection.variableIds.push(variable.id);
        return variable;
      },
      createVariableAlias: (variable) => ({ type: "VARIABLE_ALIAS", id: variable.id }),
      setBoundVariableForPaint: (paint, field, variable) => ({
        ...paint,
        boundVariables: { ...paint.boundVariables, [field]: { type: "VARIABLE_ALIAS", id: variable.id } },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function main() {
  const bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 5000 });
  const port = await bridge.start();

  let socket = null;
  const figma = createFigmaStub((message) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  });
  globalThis.figma = figma;
  globalThis.__html__ = "<html></html>";

  const url = `ws://127.0.0.1:${port}/?token=${TOKEN}`;
  socket = new WebSocket(url);
  await new Promise((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });

  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "request" && typeof figma.ui.onmessage === "function") {
      void figma.ui.onmessage(message);
    }
  });

  // The UI iframe reports which file it is attached to after connecting.
  socket.send(
    JSON.stringify({
      type: "status",
      file: { name: figma.root.name, key: figma.fileKey },
      plugin: { name: "Elf Bridge", apiVersion: figma.apiVersion },
    }),
  );

  const pluginUrl = pathToFileURL(codePath).href;
  await import(pluginUrl);

  const call = async (method, params = {}) => {
    try {
      return { ok: true, result: await bridge.request(method, params) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
  const callOk = async (method, params) => {
    const response = await call(method, params);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const callFail = async (method, params) => {
    const response = await call(method, params);
    if (response.ok) throw new Error(`expected ${method} to fail`);
    return response.error;
  };
  const errorContains = (message, fragment) => {
    if (!message.includes(fragment)) throw new Error(`expected ${JSON.stringify(fragment)} in ${JSON.stringify(message)}`);
    return message;
  };

  await check("bridge reports the plugin connected and which file", async () => {
    await waitFor(() => bridge.status.file !== null, "the bridge to see the plugin's file info");
    const status = bridge.status;
    if (!status.connected) throw new Error("not connected");
    if (status.file?.name !== "Throwaway") throw new Error(`file: ${JSON.stringify(status.file)}`);
    return status.file.name;
  });

  await check("status tool answers with file and plugin info", async () => {
    const result = await callOk("status");
    if (result.file.key !== "throwawaykey") throw new Error(JSON.stringify(result.file));
    if (result.plugin.name !== "Elf Bridge") throw new Error(JSON.stringify(result.plugin));
    return `${result.file.name} / ${result.plugin.apiVersion}`;
  });

  let core = null;
  await check("create_collection uses exactly the requested modes", async () => {
    core = await callOk("create_collection", { name: "Core", modes: ["Light", "Dark"] });
    const names = core.collection.modes.map((mode) => mode.name).join(", ");
    if (names !== "Light, Dark") throw new Error(`modes: ${names}`);
    return names;
  });

  await check("create_collection is idempotent", async () => {
    const again = await callOk("create_collection", { name: "Core", modes: ["Light", "Dark"] });
    if (again.created) throw new Error("created a second collection");
    if (again.collection.modes.length !== 2) throw new Error(`modes: ${again.collection.modes.length}`);
    return "created: false, still 2 modes";
  });

  await check("plan-limit error comes back verbatim", async () => {
    const message = await callFail("create_collection", { name: "Modes", modes: ["A", "B", "C", "D", "E"] });
    errorContains(message, "in addMode: Limited to 4 modes only");
    return message;
  });

  const variables = [
    { name: "color/primary/500", type: "COLOR", codeKey: "primary-500", values: { Light: "#6366f1", Dark: "rgb(79, 70, 229)" } },
    { name: "color/surface/base", type: "COLOR", codeKey: "surface-base", values: { Light: "#ffffff" } },
    { name: "space/4", type: "FLOAT", codeKey: "space-4", values: { Light: 16, Dark: 20 } },
    { name: "space/2", type: "FLOAT", codeKey: "space-2", values: { Light: 8 } },
    { name: "radius/md", type: "FLOAT", codeKey: "radius-md", values: { Light: 12 } },
    { name: "font/family/sans", type: "STRING", codeKey: "font-sans", values: { Light: "Inter" } },
  ];

  await check("upsert_variables creates the whole array", async () => {
    const result = await callOk("upsert_variables", { collection: "Core", variables });
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    const created = result.variables.filter((entry) => entry.action === "created").length;
    if (created !== variables.length) throw new Error(`created ${created}/${variables.length}`);
    return `${created} variables, codeKeys set`;
  });

  await check("re-running updates, never duplicates", async () => {
    const result = await callOk("upsert_variables", { collection: "Core", variables });
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    const updated = result.variables.filter((entry) => entry.action === "updated").length;
    const total = result.collection.variableCount;
    if (updated !== variables.length || total !== variables.length) {
      throw new Error(`updated ${updated}, collection holds ${total}`);
    }
    return `updated ${updated}, collection holds ${total}`;
  });

  await check("values read back per mode with names", async () => {
    const result = await callOk("list_variables", { collection: "Core", type: "COLOR" });
    const primary = result.variables.find((entry) => entry.name === "color/primary/500");
    const dark = primary?.valuesByMode?.Dark;
    if (dark?.value !== "#4f46e5") throw new Error(JSON.stringify(primary));
    if (primary.valuesByMode.Light.value !== "#6366f1") throw new Error(JSON.stringify(primary.valuesByMode));
    return `Light ${primary.valuesByMode.Light.value} / Dark ${dark.value}`;
  });

  await check("alias values resolve by name", async () => {
    const result = await callOk("upsert_variables", {
      collection: "Core",
      variables: [
        { name: "color/primary/hover", type: "COLOR", values: { Light: { variable: "color/primary/500" } } },
      ],
    });
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    const listed = await callOk("list_variables", { collection: "Core", type: "COLOR" });
    const hover = listed.variables.find((entry) => entry.name === "color/primary/hover");
    if (hover.valuesByMode.Light.type !== "VARIABLE_ALIAS") throw new Error(JSON.stringify(hover.valuesByMode));
    if (hover.valuesByMode.Light.name !== "color/primary/500") throw new Error(JSON.stringify(hover.valuesByMode));
    return `→ ${hover.valuesByMode.Light.name}`;
  });

  await check("type clash is a per-item error and other items proceed", async () => {
    const result = await callOk("upsert_variables", {
      collection: "Core",
      variables: [
        { name: "space/4", values: { Light: "#000000" } },
        { name: "space/8", type: "FLOAT", values: { Light: 32 } },
      ],
    });
    errorContains(result.errors[0]?.message ?? "", 'Variable "space/4" already exists with type FLOAT; Figma types cannot change.');
    if (result.variables[0]?.name !== "space/8") throw new Error(JSON.stringify(result.variables));
    return result.errors[0].message;
  });

  await check("rejected item leaves no half-created variable behind", async () => {
    const result = await callOk("upsert_variables", {
      collection: "Core",
      variables: [{ name: "space/16", type: "FLOAT", mode: "Nope", values: { Light: 64 } }],
    });
    errorContains(result.errors[0]?.message ?? "", 'Unknown mode "Nope" in collection "Core". Modes: Light, Dark.');
    const listed = await callOk("list_variables", { collection: "Core" });
    if (listed.variables.some((entry) => entry.name === "space/16")) throw new Error("space/16 leaked into the file");
    return "space/16 was never created";
  });

  await check("rename_variable renames and refuses a clash", async () => {
    const renamed = await callOk("rename_variable", { name: "font/family/sans", newName: "font/family/base", collection: "Core" });
    if (renamed.renamed.name !== "font/family/base") throw new Error(JSON.stringify(renamed));
    const message = await callFail("rename_variable", { name: "font/family/base", newName: "space/4", collection: "Core" });
    errorContains(message, '"space/4" already exists in collection "Core".');
    return "font/family/sans → font/family/base, clash refused";
  });

  await check("delete_variable removes hits and reports misses", async () => {
    const result = await callOk("delete_variable", { collection: "Core", names: ["space/8", "space/16", "not/here"] });
    if (result.deleted.length !== 1 || result.deleted[0].name !== "space/8") throw new Error(JSON.stringify(result.deleted));
    if (result.missing.length !== 2) throw new Error(JSON.stringify(result.missing));
    return `deleted space/8, missing ${JSON.stringify(result.missing)}`;
  });

  let componentId = null;
  await check("upsert_component creates a bound component", async () => {
    const result = await callOk("upsert_component", {
      name: "Button/Primary",
      codeKey: "button-primary",
      layoutMode: "HORIZONTAL",
      padding: { all: 12, left: { variable: "space/4" } },
      gap: { variable: "space/2" },
      cornerRadius: { variable: "radius/md" },
      fill: { variable: "color/surface/base", color: "#ffffff" },
      text: { characters: "Continue" },
    });
    componentId = result.component.id;
    const expected = ["paddingLeft", "itemSpacing", "cornerRadius", "fills"];
    for (const field of expected) {
      if (!result.boundVariables[field]) throw new Error(`missing ${field}: ${JSON.stringify(result.boundVariables)}`);
    }
    if (result.text.characters !== "Continue") throw new Error(JSON.stringify(result.text));
    return `${result.component.id}, bound ${expected.join(", ")}`;
  });

  await check("re-running the component updates in place", async () => {
    const result = await callOk("upsert_component", {
      name: "Button/Primary",
      codeKey: "button-primary",
      layoutMode: "HORIZONTAL",
      text: { characters: "Ship it" },
    });
    if (result.component.created) throw new Error("duplicated the component");
    if (result.component.id !== componentId) throw new Error(`id changed: ${result.component.id}`);
    if (result.text.characters !== "Ship it") throw new Error(JSON.stringify(result.text));
    if (result.component.childCount !== 1) throw new Error(`label stacked: ${result.component.childCount} children`);
    return `${result.component.id}, label updated in place`;
  });

  await check("gap without auto layout is refused before creating", async () => {
    const message = await callFail("upsert_component", { name: "Broken", gap: 8 });
    errorContains(message, "need auto layout");
    return message;
  });

  await check("a FLOAT variable cannot fill a layer", async () => {
    const message = await callFail("upsert_component", {
      name: "WrongFill",
      layoutMode: "HORIZONTAL",
      fill: { variable: "space/4" },
    });
    errorContains(message, 'Variable "space/4" is FLOAT, but a fill needs a COLOR variable.');
    return message;
  });

  await check("rejected components were never created", async () => {
    const listed = await callOk("list_components");
    const names = listed.components.map((entry) => entry.name);
    if (names.includes("Broken") || names.includes("WrongFill")) throw new Error(JSON.stringify(names));
    return JSON.stringify(names);
  });

  await check("get_node reads layout, bindings and label back", async () => {
    const result = await callOk("get_node", { nodeId: componentId });
    const node = result.node;
    if (node.layoutMode !== "HORIZONTAL") throw new Error(JSON.stringify(node));
    if (node.boundVariables.paddingLeft?.name !== "space/4") throw new Error(JSON.stringify(node.boundVariables));
    if (node.fills[0]?.boundVariable?.name !== "color/surface/base") throw new Error(JSON.stringify(node.fills));
    if (node.children?.[0]?.type !== "TEXT") throw new Error(JSON.stringify(node.children));
    return `paddingLeft → ${node.boundVariables.paddingLeft.name}, fill → ${node.fills[0].boundVariable.name}`;
  });

  await check("get_node on a missing id is a clear error", async () => {
    const message = await callFail("get_node", { nodeId: "99:99" });
    errorContains(message, "not found");
    return message;
  });

  await check("unknown methods are reported", async () => {
    const message = await callFail("nope");
    errorContains(message, 'Unknown method "nope".');
    return message;
  });

  socket.close();
  await bridge.stop();

  console.log("");
  if (failures > 0) {
    console.log(`${failures}/${checks} checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${checks} plugin checks passed`);
  }
}

main().catch((error) => {
  console.error("harness crashed:", error);
  process.exitCode = 1;
});
