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
      getPluginData: (key) => data.get(`private/${key}`) ?? "",
      setPluginData: (key, value) => data.set(`private/${key}`, String(value)),
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
      const previous=registry.get(node.parentId);
      if(previous?.children){const index=previous.children.indexOf(node);if(index>=0)previous.children.splice(index,1);}
      node.parentId = this.id;
      this.children.push(node);
      registry.set(node.id, node);
      return node;
    },
    findOne(predicate) {
      if (this.type === "PAGE" && !this.loaded) throw new Error("Dynamic page must load before traversal");
      for (const child of this.children) {
        if (predicate(child)) return child;
        if (child.children) {
          const found = child.findOne(predicate);
          if (found) return found;
        }
      }
      return null;
    },
    remove() {
      this.removed=true;
      const parent = registry.get(this.parentId);
      if (parent && Array.isArray(parent.children)) {
        const index = parent.children.indexOf(this);
        if (index >= 0) parent.children.splice(index, 1);
      }
      registry.delete(this.id);
    },
  });

  const page = register({ id: "0:0", name: "Page 1", type: "PAGE", loaded: false,
    async loadAsync() {this.loaded = true;}, ...pluginData(), ...childrenMixin() });

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
      strokes: [],
      description: '',
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
      createInstance() {
        return register({
          id: nextId("I"),
          name: this.name,
          type: "INSTANCE",
          getMainComponentAsync: async () => this,
          x: 0,
          y: 0,
          width: this.width,
          height: this.height,
          fills: [],
          ...pluginData(),
          ...boundVariableApi(),
          ...childrenMixin(),
        });
      },
    });

  const combineAsVariants = (components, parent) => {
    const set = register({
      id: nextId("CS"),
      name: "Component Set",
      type: "COMPONENT_SET",
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      fills: [],
      layoutMode: "NONE",
      itemSpacing: 0,
      cornerRadius: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      ...pluginData(),
      ...childrenMixin(),
      get defaultVariant() {
        return this.children.find((child) => child.type === "COMPONENT") ?? null;
      },
      resizeWithoutConstraints(width,height){this.width=width;this.height=height;},
    });
    // Figma re-parents the components into the set.
    if (parent) {
      for (const component of components) {
        const index = parent.children.indexOf(component);
        if (index >= 0) parent.children.splice(index, 1);
      }
      set.parentId = parent.id;
      parent.children.push(set);
    }
    for (const component of components) {
      component.parentId = set.id;
      set.children.push(component);
    }
    return set;
  };

  const textStyles = [];
  const effectStyles = [];

  const createTextStyle = () => {
    const style = {
      id: nextId("TS"),
      name: "Text style",
      description: "",
      fontName: { family: "Inter", style: "Regular" },
      fontSize: 12,
      lineHeight: { unit: "AUTO" },
      letterSpacing: { unit: "PERCENT", value: 0 },
      ...pluginData(),
    };
    textStyles.push(style);
    return style;
  };

  const createEffectStyle = () => {
    const style = { id: nextId("ES"), name: "Effect style", description: "", effects: [], ...pluginData() };
    effectStyles.push(style);
    return style;
  };

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
      ...childrenMixin(),
      resize(width,height){this.width=width;this.height=height;},
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
    root: { name: "Throwaway", children: [page], ...pluginData() },
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
    createFrame:()=>Object.assign(createComponent(),{type:'FRAME'}),
    createRectangle:()=>Object.assign(createComponent(),{type:'RECTANGLE'}),
    createEllipse:()=>Object.assign(createComponent(),{type:'ELLIPSE'}),
    createVector:()=>Object.assign(createComponent(),{type:'VECTOR'}),
    combineAsVariants,
    createTextStyle,
    createEffectStyle,
    getLocalTextStylesAsync: async () => textStyles,
    getLocalEffectStylesAsync: async () => effectStyles,
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
      void figma.ui.onmessage({ ...message, channel: "a".repeat(64) });
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
  await figma.ui.onmessage({ type: "context", channel: "a".repeat(64) });

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

  const buttonVariants = [
    { props: { size: "sm", intent: "primary" }, spec: { padding: { all: 8 }, text: { characters: "Go" } } },
    { props: { size: "sm", intent: "secondary" }, spec: { padding: { all: 8 } } },
    { props: { size: "md", intent: "primary" } },
    { props: { size: "md", intent: "secondary" } },
  ];

  let buttonSet = null;
  await check("upsert_component_set builds a set from variant props", async () => {
    buttonSet = await callOk("upsert_component_set", {
      name: "Button",
      codeKey: "button",
      layoutMode: "VERTICAL",
      gap: 8,
      padding: { all: 12 },
      variants: buttonVariants,
    });
    if (!buttonSet.set.created) throw new Error("expected the set to be created");
    if (buttonSet.set.variantCount !== 4) throw new Error(`variants: ${buttonSet.set.variantCount}`);
    const names = buttonSet.set.variants.map((entry) => entry.name).join(" | ");
    if (!names.includes("size=sm, intent=primary")) throw new Error(names);
    return `${buttonSet.set.id} — ${names}`;
  });

  await check("re-running the set updates variants in place", async () => {
    const again = await callOk("upsert_component_set", {
      name: "Button",
      codeKey: "button",
      layoutMode: "VERTICAL",
      gap: 8,
      padding: { all: 12 },
      variants: buttonVariants,
    });
    if (again.set.created) throw new Error("rebuilt instead of updating");
    if (again.set.id !== buttonSet.set.id) throw new Error(`set id changed: ${again.set.id}`);
    if (again.set.variantCount !== 4) throw new Error(`variants: ${again.set.variantCount}`);
    return `${again.set.id}, updated in place`;
  });

  await check("variant property mismatch is refused with the set intact", async () => {
    const message = await callFail("upsert_component_set", {
      name: "Button",
      codeKey: "button",
      variants: [{ props: { size: "sm" } }, { props: { intent: "primary" } }],
    });
    errorContains(message, "Every variant must declare the same variant properties");
    const node = await callOk("get_node", { nodeId: buttonSet.set.id, depth: 1 });
    if (node.node.children.length !== 4) throw new Error(`variants after refusal: ${node.node.children.length}`);
    return message;
  });

  await check("duplicate variant values are refused", async () => {
    const message = await callFail("upsert_component_set", {
      name: "Button",
      codeKey: "button",
      variants: [{ props: { size: "sm" } }, { props: { size: "sm" } }],
    });
    errorContains(message, "Two variants share the same property values");
    return message;
  });

  await check("a changed variant roster retains omitted variants without rebuilding the set", async () => {
    const before=await figma.getNodeByIdAsync(buttonSet.set.id),ids=before.children.map(child=>child.id).join(',');
    const rebuilt = await callOk("upsert_component_set", {
      name: "Button",
      codeKey: "button",
      variants: [
        { props: { size: "sm", intent: "primary" } },
        { props: { size: "md", intent: "primary" } },
      ],
    });
    if (rebuilt.set.created||rebuilt.set.id!==buttonSet.set.id) throw new Error("unexpected rebuild");
    if (rebuilt.set.variantCount !== 4||rebuilt.set.retainedVariants.length!==2||before.children.map(child=>child.id).join(',')!==ids) throw new Error('omitted variants changed or were removed');
    return `${rebuilt.set.id}, original 4 variants preserved`;
  });

  let slotId = null;
  await check('original masters promote into sets and added states preserve master, set and instance identities',async()=>{
    const original=await callOk('upsert_component',{name:'Promoted button',codeKey:'test/promoted-button',layoutMode:'NONE',size:{width:100,height:32}});
    const master=await figma.getNodeByIdAsync(original.component.id),instance=master.createInstance();
    const input={name:'Promoted button',codeKey:'test/promoted-button',layoutMode:'NONE',size:{width:100,height:32},variants:[{props:{State:'Default'}},{props:{State:'Hover'}}]};
    const first=await callOk('upsert_component_set',input);
    if(first.set.promotedComponentId!==master.id||first.set.variants[0].id!==master.id||(await instance.getMainComponentAsync()).id!==master.id)throw new Error('promotion lost the existing master or instance');
    const set=await figma.getNodeByIdAsync(first.set.id),ids=set.children.map(child=>child.id);
    const added=await callOk('upsert_component_set',{...input,variants:[...input.variants,{props:{State:'Pressed'}},{props:{State:'Focus'}},{props:{State:'Disabled'}}]});
    if(added.set.id!==set.id||added.set.created||ids.some(id=>!set.children.some(child=>child.id===id))||set.children.length!==5)throw new Error('state addition replaced existing variants');
    const schemaError=await callFail('upsert_component_set',{...input,variants:[{props:{Mode:'New property'}}]});
    errorContains(schemaError,'separate migration');
    const before=set.children.map(child=>child.id).join(',');
    await callFail('upsert_component_set',{...input,variants:[...input.variants,{props:{State:'Error'},spec:{text:{characters:'No',fontFamily:'Unavailable'}}}]});
    if(set.children.map(child=>child.id).join(',')!==before)throw new Error('failed preparation changed existing states');
    if(!set.width||!set.height)throw new Error('variant set bounds were not resized');
    return 'promotion, additions, schema refusal and failed preparation preserve identities';
  });

  await check("instance children point at components by codeKey", async () => {
    const result = await callOk("upsert_component", {
      name: "IconSlot",
      codeKey: "icon-slot",
      layoutMode: "HORIZONTAL",
      children: [
        { type: "instance", component: "button-primary" },
        { type: "instance", component: "button" },
      ],
    });
    slotId = result.component.id;
    if (result.children.length !== 2) throw new Error(JSON.stringify(result.children));
    if (result.children[0].type !== "INSTANCE") throw new Error(JSON.stringify(result.children[0]));
    if (result.children[0].codeKey !== "button-primary") throw new Error(JSON.stringify(result.children[0]));
    if (result.children[1].codeKey !== "button") throw new Error(JSON.stringify(result.children[1]));
    return `slots → ${result.children.map((child) => child.codeKey).join(", ")}`;
  });

  await check("re-running with fewer children replaces the slots wholesale", async () => {
    const result = await callOk("upsert_component", {
      name: "IconSlot",
      codeKey: "icon-slot",
      children: [{ type: "instance", component: "button" }],
    });
    if (result.children.length !== 1) throw new Error(JSON.stringify(result.children));
    if (result.component.childCount !== 1) throw new Error(`childCount: ${result.component.childCount}`);
    return "2 slots → 1 slot, nothing stacked";
  });

  await check("a missing slot target is refused and leaves slots untouched", async () => {
    const message = await callFail("upsert_component", {
      name: "IconSlot",
      codeKey: "icon-slot",
      children: [{ type: "instance", component: "does-not-exist" }],
    });
    errorContains(message, "no component with that codeKey");
    const node = await callOk("get_node", { nodeId: slotId, depth: 1 });
    if (node.node.children.length !== 1) throw new Error(`slots after refusal: ${node.node.children.length}`);
    return message;
  });

  await check("upsert_text_style creates, then updates the same style", async () => {
    const created = await callOk("upsert_text_style", {
      name: "Body/Regular",
      codeKey: "text-body",
      fontFamily: "Inter",
      fontStyle: "Regular",
      fontSize: 14,
      lineHeight: { percent: 150 },
      letterSpacing: { percent: 0 },
    });
    if (!created.style.created) throw new Error("expected created: true");
    const again = await callOk("upsert_text_style", {
      name: "Body/Regular",
      codeKey: "text-body",
      fontSize: 16,
    });
    if (again.style.created) throw new Error("duplicated the style");
    if (again.style.id !== created.style.id) throw new Error(`style id changed: ${again.style.id}`);
    if (again.style.fontSize !== 16) throw new Error(`fontSize: ${again.style.fontSize}`);
    return `${again.style.id}, re-run updated in place`;
  });

  await check("an unavailable font fails before the style exists", async () => {
    const message = await callFail("upsert_text_style", {
      name: "Broken/Font",
      codeKey: "text-broken",
      fontFamily: "NoSuchFont",
    });
    errorContains(message, "could not be loaded");
    const styles = await figma.getLocalTextStylesAsync();
    if (styles.some((style) => style.name === "Broken/Font")) throw new Error("orphan style left behind");
    return message;
  });

  await check("upsert_effect_style replaces the whole effect list", async () => {
    const created = await callOk("upsert_effect_style", {
      name: "Elevation/1",
      codeKey: "elevation-1",
      effects: [{ type: "DROP_SHADOW", color: "#00000040", offset: { x: 0, y: 2 }, radius: 4, spread: 0 }],
    });
    if (!created.style.created) throw new Error("expected created: true");
    const again = await callOk("upsert_effect_style", {
      name: "Elevation/1",
      codeKey: "elevation-1",
      effects: [
        { type: "DROP_SHADOW", color: "#00000040", offset: { x: 0, y: 2 }, radius: 4 },
        { type: "LAYER_BLUR", radius: 8 },
      ],
    });
    if (again.style.created || again.style.id !== created.style.id) throw new Error("style identity changed");
    if (again.style.effectCount !== 2) throw new Error(`effects: ${again.style.effectCount}`);
    return `${again.style.id}, 1 → 2 effects`;
  });

  await check("bad effect input fails and leaves no orphan style", async () => {
    const unsupported = await callFail("upsert_effect_style", {
      name: "Elevation/2",
      effects: [{ type: "GLOW" }],
    });
    errorContains(unsupported, "unsupported type");
    const empty = await callFail("upsert_effect_style", { name: "Elevation/2", effects: [] });
    errorContains(empty, "at least one effect");
    const styles = await figma.getLocalEffectStylesAsync();
    if (styles.some((style) => style.name === "Elevation/2")) throw new Error("orphan effect style left behind");
    return "both refusals clean";
  });

  await check('rich components stage nested bound layers, prose and canvas placement, and rerun without duplicate roots',async()=>{
    const input={name:'Rich switch',codeKey:'test/rich-switch',description:'Immediate on/off setting; no separate save step.',position:{x:800,y:400},layoutMode:'NONE',size:{width:240,height:32},layers:[
      {type:'frame',name:'Track',position:{x:0,y:6},size:{width:36,height:20},fill:{variable:'color/primary/500'},cornerRadius:10},
      {type:'ellipse',name:'Thumb',parent:0,position:{x:18,y:2},size:{width:16,height:16},fill:{color:'#ffffff'}},
      {type:'text',name:'Label',position:{x:44,y:6},align:'RIGHT',text:{characters:'Email receipts on',fontSize:14,color:{variable:'color/primary/500'}}},
      {type:'vector',name:'Illustrative trend',position:{x:0,y:40},points:[{x:0,y:20},{x:20,y:0},{x:40,y:10}],stroke:{color:{color:'#112233'},weight:2}},
    ]};
    const first=await callOk('upsert_component',input),node=await figma.getNodeByIdAsync(first.component.id);
    if(node.description!==input.description||node.x!==800||node.y!==400)throw new Error('metadata/position not applied');
    if(node.children.length!==3||node.children[0].children[0].type!=='ELLIPSE')throw new Error('nested shapes missing');
    if(!node.children[0].fills[0].boundVariables?.color||!node.children[1].fills[0].boundVariables?.color)throw new Error('variable bindings missing');
    if(node.children[1].textAlignHorizontal!=='RIGHT')throw new Error('text alignment missing');
    if(node.children[2].vectorPaths[0].data!=='M 0 20 L 20 0 L 40 10')throw new Error('vector path differs');
    const manual=figma.createText();manual.name='Designer note';node.appendChild(manual);
    const again=await callOk('upsert_component',input);
    if(again.component.id!==first.component.id||node.children.length!==4||!node.children.includes(manual))throw new Error('rerun changed identity, duplicated roots or removed designer work');
    return 'nested geometry, bindings, prose, position and owned-root replacement verified';
  });

  await check('get_node reads nested scene opacity independently of paint opacity, including zero',async()=>{
    const result=await callOk('upsert_component',{name:'Opacity readback',codeKey:'test/opacity-readback',layers:[
      {type:'frame',name:'Faded surface',size:{width:120,height:40},opacity:0.4,fill:{color:'#6633ff',opacity:0.7}},
      {type:'rectangle',name:'Hidden child',parent:0,size:{width:10,height:10},opacity:0,fill:{color:'#ffffff'}},
    ]});
    const read=await callOk('get_node',{nodeId:result.component.id,depth:2});
    const frame=read.node.children[0],child=frame.children[0];
    if(frame.opacity!==0.4||frame.fills[0].opacity!==0.7||child.opacity!==0)throw new Error('node opacity missing, conflated with paint, or zero lost');
    const shallow=await callOk('get_node',{nodeId:frame.id,depth:0});
    if(shallow.node.opacity!==0.4)throw new Error('depth-zero opacity missing');
    return 'nested .4, paint .7, hidden zero and depth-zero read-back verified';
  });

  await check('rich variant sets preserve identities and put usage prose on both the set and variants',async()=>{
    const input={name:'Rich toggle set',codeKey:'test/rich-toggle-set',description:'Immediate setting; label describes the on state.',position:{x:1200,y:400},layoutMode:'NONE',size:{width:36,height:20},layers:[{type:'ellipse',name:'Thumb',size:{width:16,height:16},fill:{color:'#ffffff'}}],variants:[{props:{Checked:'Off'}},{props:{Checked:'On'}}]};
    const first=await callOk('upsert_component_set',input),set=await figma.getNodeByIdAsync(first.set.id);
    if(set.description!==input.description||set.x!==1200||set.y!==400||set.children.some(child=>child.description!==input.description))throw new Error('variant metadata missing');
    const ids=set.children.map(child=>child.id).join(',');
    await callOk('upsert_component_set',input);
    if(set.children.map(child=>child.id).join(',')!==ids||set.children.some(child=>child.children.length!==1))throw new Error('variant update duplicated or replaced identities');
    return 'metadata and same-roster reruns verified';
  });

  await check('rich layer validation refuses unsafe, oversized, unowned and unresolved input before creating components',async()=>{
    const base={name:'Rejected rich',codeKey:'test/rejected-rich',layers:[{type:'text',name:'Label',text:{characters:'Hello'}}]};
    const count=figma.currentPage.children.length;
    for(const patch of [
      {layers:[{...base.layers[0],url:'https://example.com'}]},
      {layers:[{type:'rectangle',name:'Bad',parent:0}]},
      {layers:Array.from({length:201},()=>({type:'rectangle',name:'Too many'}))},
      {layers:[{type:'vector',name:'Bad',points:[{x:Infinity,y:0},{x:1,y:2}]}]},
      {layers:[{type:'text',name:'Bad font',text:{characters:'No',fontFamily:'Unavailable'}}]},
      {layers:[{type:'rectangle',name:'Missing variable',fill:{variable:'does-not-exist'}}]},
      {layers:[{type:'ellipse',name:'Bad radius',cornerRadius:4}]},
      {position:{x:1e10,y:0}},
      {codeKey:''},
    ])await callFail('upsert_component',{...base,...patch});
    if(figma.currentPage.children.length!==count)throw new Error('invalid layers left canvas nodes');
    const existing=await callOk('upsert_component',{name:base.name,layoutMode:'NONE'});
    await callFail('upsert_component',base);
    const node=await figma.getNodeByIdAsync(existing.component.id);
    if(node.getSharedPluginData('elf','codeKey'))throw new Error('name collision silently adopted');
    return 'no orphan components or implicit name adoption';
  });

  await check('hosted snapshot is bounded, deterministic and changes with the page',async()=>{
    const before=JSON.stringify(await callOk('get_hosted_snapshot'));
    if(before!==JSON.stringify(await callOk('get_hosted_snapshot')))throw new Error('unchanged snapshot is unstable');
    const node=figma.createText();node.characters='Hosted guard';figma.currentPage.appendChild(node);
    if(before===JSON.stringify(await callOk('get_hosted_snapshot')))throw new Error('page edits did not change the snapshot');
    node.remove();
    return 'current page, variables, modes and styles included';
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
