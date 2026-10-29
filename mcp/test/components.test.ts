import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Bridge } from "../src/bridge.js";
import { PluginClient } from "../src/client.js";
import { BridgeError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { getNodeTool, listComponentsTool, upsertComponentTool } from "../src/tools/components.js";
import type { MethodHandler } from "./helpers/plugin-connection.js";
import { FakePlugin } from "./helpers/plugin-connection.js";

const TOKEN = "test-token-0123456789";

test('rich component calls require updated plugin capabilities and forward prose, position and layers',async()=>{
 const calls:{method:string;params:any}[]=[];
 let supported=false;
 const bridge:any={request:async(method:string,params:any)=>{
  calls.push({method,params});
  if(method==='get_plugin_capabilities')return supported?{visualLayers:1,componentMetadata:1}:{};
  return {component:{id:'rich:1',created:true},boundVariables:{},text:null,children:[]};
 }};
 const client=new PluginClient(bridge);
 const input={name:'Switch',codeKey:'rift/switch',description:'Immediate on/off setting.',position:{x:100,y:200},layers:[{type:'text' as const,name:'Label',text:{characters:'Email receipts on'}}]};
 await assert.rejects(upsertComponentTool.handler(client,input),/Reopen the updated/);
 assert.deepEqual(calls.map(call=>call.method),['get_plugin_capabilities']);
 supported=true;
 await upsertComponentTool.handler(client,input);
 assert.equal(calls.at(-1)?.method,'upsert_component');
 for(const key of ['description','position','layers'] as const)assert.deepEqual(calls.at(-1)?.params[key],input[key]);
});

/**
 * A stand-in for the plugin's node side: components matched by codeKey then
 * name, with the bound fields recorded so the tools can be checked against it.
 */
function createFakeNodes() {
  interface FakeComponent {
    id: string;
    name: string;
    codeKey: string | null;
    parentId: string;
    layoutMode: string;
    padding: Record<string, unknown>;
    gap: unknown;
    cornerRadius: unknown;
    fill: unknown;
    bound: Record<string, { variableId: string; variableName: string }>;
    label: { id: string; characters: string } | null;
  }

  const components: FakeComponent[] = [];
  let counter = 0;

  const handlers: Record<string, MethodHandler> = {
    list_components: (params) => ({
      parentId: (params.parentId as string) ?? "0:0",
      components: components
        .filter((component) => !params.parentId || component.parentId === params.parentId)
        .map((component) => ({
          id: component.id,
          name: component.name,
          codeKey: component.codeKey,
          parentId: component.parentId,
          width: 120,
          height: 40,
          layoutMode: component.layoutMode,
          childCount: component.label ? 1 : 0,
        })),
    }),

    upsert_component: (params) => {
      const spec = params as {
        name: string;
        codeKey?: string;
        parentId?: string;
        layoutMode?: string;
        padding?: Record<string, unknown>;
        gap?: unknown;
        cornerRadius?: unknown;
        fill?: { variable?: string; color?: string };
        text?: { characters: string };
      };
      const parentId = spec.parentId ?? "0:0";
      let component = spec.codeKey
        ? components.find((candidate) => candidate.codeKey === spec.codeKey)
        : components.find((candidate) => candidate.name === spec.name);
      const created = !component;
      if (!component) {
        component = {
          id: `10:${++counter}`,
          name: spec.name,
          codeKey: null,
          parentId,
          layoutMode: "NONE",
          padding: {},
          gap: undefined,
          cornerRadius: undefined,
          fill: undefined,
          bound: {},
          label: null,
        };
        components.push(component);
      }

      component.name = spec.name;
      if (spec.codeKey) component.codeKey = spec.codeKey;
      if (spec.layoutMode) component.layoutMode = spec.layoutMode;
      if (spec.padding) component.padding = spec.padding;
      if (spec.gap !== undefined) component.gap = spec.gap;
      if (spec.cornerRadius !== undefined) component.cornerRadius = spec.cornerRadius;
      if (spec.fill) component.fill = spec.fill;

      for (const field of ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing", "cornerRadius", "fills"]) {
        const ref = refFor(field, spec);
        if (ref) component.bound[field] = { variableId: `VariableID:fake:${field}`, variableName: ref };
      }

      if (spec.text) {
        component.label = component.label ?? { id: `20:${++counter}`, characters: "" };
        component.label.characters = spec.text.characters;
      }

      return {
        component: {
          id: component.id,
          name: component.name,
          codeKey: component.codeKey,
          parentId: component.parentId,
          width: 120,
          height: 40,
          layoutMode: component.layoutMode,
          childCount: component.label ? 1 : 0,
          created,
        },
        boundVariables: component.bound,
        text: component.label,
      };
    },

    get_node: (params) => {
      const component = components.find((candidate) => candidate.id === params.nodeId);
      if (!component) throw new Error(`Node ${String(params.nodeId)} not found in this file.`);
      return {
        node: {
          id: component.id,
          name: component.name,
          type: "COMPONENT",
          codeKey: component.codeKey,
          layoutMode: component.layoutMode,
          width: 120,
          height: 40,
          x: 0,
          y: 0,
          itemSpacing: 8,
          paddingTop: 12,
          paddingRight: 16,
          paddingBottom: 12,
          paddingLeft: 16,
          cornerRadius: component.cornerRadius ?? 0,
          fills: [
            {
              type: "SOLID",
              color: { r: 0, g: 0, b: 0 },
              opacity: 1,
              boundVariable: component.bound.fills ?? null,
            },
          ],
          boundVariables: component.bound,
          children: component.label
            ? [
                {
                  id: component.label.id,
                  name: component.label.characters,
                  type: "TEXT",
                  codeKey: null,
                  boundVariables: {},
                  children: [],
                },
              ]
            : [],
        },
      };
    },
  };

  return { handlers, components };
}

function refFor(field: string, spec: Record<string, unknown>): string | null {
  if (field === "itemSpacing" || field === "cornerRadius") {
    const value = (field === "itemSpacing" ? spec.gap : spec.cornerRadius) as { variable?: string } | undefined;
    return typeof value === "object" && value?.variable ? value.variable : null;
  }
  if (field === "fills") {
    const value = spec.fill as { variable?: string } | undefined;
    return typeof value === "object" && value?.variable ? value.variable : null;
  }
  const padding = spec.padding as Record<string, { variable?: string }> | undefined;
  const side = field.replace("padding", "").toLowerCase() as "top" | "right" | "bottom" | "left";
  const value = padding?.[side] ?? padding?.all;
  return typeof value === "object" && value?.variable ? value.variable : null;
}

const BUTTON = {
  name: "Button/Primary",
  codeKey: "button-primary",
  layoutMode: "HORIZONTAL" as const,
  padding: { all: 12, left: { variable: "space/4" } },
  gap: { variable: "space/2" },
  cornerRadius: 6,
  fill: { variable: "color/accent", color: "#000000" },
  text: { characters: "Continue", fontFamily: "Inter", fontStyle: "Regular", fontSize: 14 },
};

describe("component tools over the real bridge", () => {
  let bridge: Bridge;
  let client: PluginClient;
  let plugin: FakePlugin;
  let nodes: ReturnType<typeof createFakeNodes>;

  before(async () => {
    nodes = createFakeNodes();
    bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 1000, logger: silentLogger });
    const port = await bridge.start();
    client = new PluginClient(bridge);
    plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: nodes.handlers });
  });

  after(async () => {
    plugin.close();
    await bridge.stop();
  });

  test("upsert_component creates a component and returns its id", async () => {
    const payload = await upsertComponentTool.handler(client, BUTTON);

    assert.equal(payload.ok, true);
    assert.equal(payload.created, true);
    const component = payload.component as { id: string; name: string; codeKey: string };
    assert.equal(component.name, "Button/Primary");
    assert.equal(component.codeKey, "button-primary");
    assert.ok(component.id);
    assert.deepEqual(payload.text, { id: (payload.text as { id: string }).id, characters: "Continue" });
  });

  test("upsert_component forwards variable references instead of values", async () => {
    const payload = await upsertComponentTool.handler(client, BUTTON);
    const bound = payload.boundVariables as Record<string, { variableName: string }>;

    assert.equal(bound.fills.variableName, "color/accent");
    assert.equal(bound.itemSpacing.variableName, "space/2");
    assert.equal(bound.paddingLeft.variableName, "space/4");
    assert.equal(bound.paddingTop, undefined, "unbound sides stay literal");
    assert.equal(bound.cornerRadius, undefined, "a literal radius binds nothing");
  });

  test("upsert_component matches on codeKey, so a second call updates", async () => {
    const before = nodes.components.length;

    const payload = await upsertComponentTool.handler(client, {
      ...BUTTON,
      name: "Button/Primary v2",
      text: { ...BUTTON.text, characters: "Next" },
    });

    assert.equal(payload.created, false);
    assert.equal(nodes.components.length, before, "no duplicate component");
    assert.equal((payload.component as { name: string }).name, "Button/Primary v2");
    assert.equal((payload.text as { characters: string }).characters, "Next");
  });

  test("list_components finds the component again", async () => {
    const payload = await listComponentsTool.handler(client, {});
    assert.equal(payload.ok, true);
    const components = payload.components as { id: string; name: string; codeKey: string }[];

    assert.equal(components.length, 1);
    assert.equal(components[0].id, nodes.components[0].id);
    assert.equal(components[0].name, "Button/Primary v2");
    assert.equal(components[0].codeKey, "button-primary");
  });

  test("get_node reads back layout, fills and the bound variables", async () => {
    const payload = await getNodeTool.handler(client, { nodeId: nodes.components[0].id, depth: 1 });
    const node = payload.node as {
      name: string;
      type: string;
      layoutMode: string;
      paddingLeft: unknown;
      boundVariables: Record<string, { variableName: string }>;
      fills: { boundVariable: { variableName: string } | null }[];
      children: { type: string; name: string }[];
    };

    assert.equal(node.name, "Button/Primary v2");
    assert.equal(node.type, "COMPONENT");
    assert.equal(node.layoutMode, "HORIZONTAL");
    assert.equal(node.boundVariables.fills.variableName, "color/accent");
    assert.equal(node.fills[0].boundVariable?.variableName, "color/accent");
    assert.deepEqual(node.children.map((child) => child.type), ["TEXT"]);
  });

  test("get_node surfaces a missing node with the plugin's own message", async () => {
    await assert.rejects(
      () => getNodeTool.handler(client, { nodeId: "99:99" }),
      (error: BridgeError) => {
        assert.equal(error.code, "plugin");
        assert.match(error.message, /Node 99:99 not found/);
        return true;
      },
    );
  });

  test("component tools carry an id the plugin can match on", async () => {
    const before = plugin.requests.length;
    await listComponentsTool.handler(client, { deep: true });

    const request = plugin.requests[before];
    assert.equal(request.method, "list_components");
    assert.deepEqual(request.params, { deep: true });
    assert.ok(request.id);
  });
});

describe("component tools without a plugin", () => {
  test("fail with the open-the-plugin hint", async () => {
    const bridge = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
    await bridge.start();
    const client = new PluginClient(bridge);

    const calls = [
      () => listComponentsTool.handler(client, {}),
      () => upsertComponentTool.handler(client, BUTTON),
      () => getNodeTool.handler(client, { nodeId: "1:2" }),
    ];
    for (const call of calls) {
      await assert.rejects(call, (error: BridgeError) => {
        assert.equal(error.code, "not-connected");
        assert.match(error.message, /open the Elf Bridge plugin in Figma/);
        return true;
      });
    }

    await bridge.stop();
  });
});
