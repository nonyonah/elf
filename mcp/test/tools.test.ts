import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Bridge } from "../src/bridge.js";
import { PluginClient } from "../src/client.js";
import { silentLogger } from "../src/logger.js";
import { BridgeError } from "../src/errors.js";
import { statusTool } from "../src/tools/status.js";
import {
  createCollectionTool,
  deleteVariableTool,
  listCollectionsTool,
  listVariablesTool,
  renameVariableTool,
  upsertVariablesTool,
} from "../src/tools/variables.js";
import { createFakeFigma, type FakeFigma } from "./helpers/fake-figma.js";
import { FakePlugin, waitFor } from "./helpers/plugin-connection.js";

const TOKEN = "test-token-0123456789";

const CORE_VARIABLES = [
  { name: "color/primary/500", type: "COLOR", codeKey: "primary-500", values: { Light: "#6366f1" } },
  { name: "color/surface/base", type: "COLOR", codeKey: "surface-base", values: { Light: "#ffffff" } },
  { name: "space/4", type: "FLOAT", codeKey: "space-4", values: { Light: 16 } },
  { name: "radius/md", type: "FLOAT", codeKey: "radius-md", values: { Light: 6 } },
  { name: "font/family/sans", type: "STRING", codeKey: "font-sans", values: { Light: "Inter" } },
] as const;

describe("variable tools over the real bridge", () => {
  let bridge: Bridge;
  let client: PluginClient;
  let plugin: FakePlugin;
  let figma: FakeFigma;

  before(async () => {
    figma = createFakeFigma();
    bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 1000, logger: silentLogger });
    const port = await bridge.start();
    client = new PluginClient(bridge);
    plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: figma.handlers });
    plugin.sendStatus({ name: "Throwaway File", key: "fakefilekey" });
    await waitFor(() => bridge.status.file !== null);
  });

  after(async () => {
    plugin.close();
    await bridge.stop();
  });

  test("status reports the connected file, port and loopback address", async () => {
    const payload = await statusTool.handler(client, {});
    assert.equal(payload.ok, true);
    assert.equal(payload.connected, true);
    assert.equal(payload.port, (bridge.status.port));
    assert.equal(payload.address, "127.0.0.1");
    assert.deepEqual(payload.file, { name: "Throwaway File", key: "fakefilekey" });
  });

  test("create_collection is idempotent and adds only missing modes", async () => {
    const first = await createCollectionTool.handler(client, { name: "Core", modes: ["Light", "Dark"] });
    assert.equal(first.ok, true);
    const collection = first.collection as { id: string; modes: { name: string }[]; variableCount: number };
    assert.equal(collection.modes.length, 2);
    assert.equal(collection.variableCount, 0);

    const second = await createCollectionTool.handler(client, { name: "Core", modes: ["Light", "Dark"] });
    const sameCollection = second.collection as { id: string; modes: { name: string }[] };
    assert.equal(sameCollection.id, collection.id);
    assert.deepEqual(sameCollection.modes, collection.modes);
    assert.equal(figma.collections.length, 1, "re-running must not create a second collection");
  });

  test("upsert_variables creates an array of variables and returns their ids", async () => {
    const payload = await upsertVariablesTool.handler(client, {
      collection: "Core",
      defaultMode: "Light",
      variables: [...CORE_VARIABLES],
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.created, 5);
    assert.equal(payload.updated, 0);
    const variables = payload.variables as { id: string; name: string; action: string; codeKey: string | null }[];
    assert.equal(variables.length, 5);
    assert.ok(variables.every((variable) => /^VariableID:/.test(variable.id)), "every touched variable returns an id");
    assert.ok(variables.every((variable) => variable.action === "created"));
    assert.deepEqual(
      variables.map((variable) => variable.codeKey),
      CORE_VARIABLES.map((variable) => variable.codeKey),
    );
  });

  test("upsert_variables runs twice without duplicating anything", async () => {
    const before = figma.collections[0].variables.length;

    const payload = await upsertVariablesTool.handler(client, {
      collection: "Core",
      defaultMode: "Light",
      variables: [...CORE_VARIABLES],
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.created, 0);
    assert.equal(payload.updated, 5);
    assert.equal(figma.collections[0].variables.length, before, "no new variables were created");

    const variables = payload.variables as { id: string; action: string }[];
    assert.ok(variables.every((variable) => variable.action === "updated"));
  });

  test("upsert_variables tags every variable with its codeKey", async () => {
    const payload = await listVariablesTool.handler(client, { collection: "Core" });
    const variables = payload.variables as { name: string; codeKey: string | null }[];

    for (const variable of CORE_VARIABLES) {
      const stored = variables.find((candidate) => candidate.name === variable.name);
      assert.equal(stored?.codeKey, variable.codeKey, `${variable.name} should carry its codeKey`);
    }
  });

  test("upsert_variables reports per-item errors and still returns the rest", async () => {
    const payload = await upsertVariablesTool.handler(client, {
      collection: "Core",
      defaultMode: "Light",
      variables: [
        { name: "space/8", type: "FLOAT", values: { Light: 32 } },
        { name: "space/4", type: "STRING", values: { Light: "oops" } },
        { name: "color/surface/base", type: "COLOR", values: { Light: "#111111" } },
      ],
    });

    assert.equal(payload.ok, false);
    assert.match(String(payload.error), /1 variable\(s\) failed, 2 succeeded/);
    const errors = payload.errors as { name: string; message: string }[];
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "space/4");
    assert.match(errors[0].message, /types cannot change/);
    assert.equal(payload.created, 1, "space/8 is new");
    assert.equal(payload.updated, 1, "color/surface/base still went through");

    // The colour really was updated despite the failure in the middle of the batch.
    const listed = await listVariablesTool.handler(client, { collection: "Core" });
    const base = (listed.variables as { name: string; valuesByMode: Record<string, { value: unknown }> }[]).find(
      (variable) => variable.name === "color/surface/base",
    );
    const [value] = Object.values(base!.valuesByMode);
    assert.deepEqual(value.value, { r: 17 / 255, g: 17 / 255, b: 17 / 255, a: 1 });
  });

  test("upsert_variables forwards an unknown collection error verbatim", async () => {
    await assert.rejects(
      () => upsertVariablesTool.handler(client, { collection: "Nope", variables: [] }),
      (error: BridgeError) => {
        assert.equal(error.code, "plugin");
        assert.match(error.message, /Variable collection "Nope" not found/);
        return true;
      },
    );
  });

  test("list_collections and list_variables read what was written", async () => {
    const collections = await listCollectionsTool.handler(client, {});
    assert.equal(collections.ok, true);
    assert.equal(collections.collectionCount, 1);
    assert.deepEqual(
      (collections.collections as { name: string }[]).map((collection) => collection.name),
      ["Core"],
    );

    const floats = await listVariablesTool.handler(client, { collection: "Core", type: "FLOAT" });
    assert.equal(floats.ok, true);
    assert.equal(floats.variableCount, 3);
    assert.deepEqual(
      (floats.variables as { name: string }[]).map((variable) => variable.name).sort(),
      ["radius/md", "space/4", "space/8"],
    );
  });

  test("rename_variable renames once and is a no-op when repeated", async () => {
    const first = await renameVariableTool.handler(client, {
      collection: "Core",
      name: "color/primary/500",
      newName: "color/primary/base",
    });
    assert.equal(first.ok, true);
    assert.deepEqual(first.variable, {
      id: (first.variable as { id: string }).id,
      previousName: "color/primary/500",
      name: "color/primary/base",
      collectionId: (first.variable as { collectionId: string }).collectionId,
      collectionName: "Core",
    });

    const again = await renameVariableTool.handler(client, {
      id: (first.variable as { id: string }).id,
      newName: "color/primary/base",
    });
    assert.equal(again.ok, true);
    assert.equal((again.variable as { previousName: string }).previousName, "color/primary/base");
  });

  test("rename_variable refuses to create a duplicate name", async () => {
    // The plugin raises the clash, and the bridge relays the message untouched.
    await assert.rejects(
      () =>
        renameVariableTool.handler(client, {
          collection: "Core",
          name: "color/surface/base",
          newName: "radius/md",
        }),
      (error: BridgeError) => {
        assert.equal(error.code, "plugin");
        assert.equal(error.message, '"radius/md" already exists in collection "Core".');
        return true;
      },
    );
  });

  test("rename_variable needs an id or a name", async () => {
    const payload = await renameVariableTool.handler(client, { newName: "whatever" });
    assert.equal(payload.ok, false);
    assert.match(String(payload.error), /either `id` or `name`/);
  });

  test("delete_variable removes arrays of names and ids", async () => {
    const before = figma.collections[0].variables.length;

    const payload = await deleteVariableTool.handler(client, {
      collection: "Core",
      names: ["space/8", "font/family/sans", "does/not/exist"],
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.deletedCount, 2);
    assert.deepEqual(payload.missing, ["does/not/exist"]);
    assert.equal(figma.collections[0].variables.length, before - 2);

    const listed = await listVariablesTool.handler(client, { collection: "Core" });
    const ids = (listed.variables as { id: string }[]).map((variable) => variable.id);
    const byId = await deleteVariableTool.handler(client, { ids: ids.slice(0, 1) });
    assert.equal(byId.deletedCount, 1);
  });

  test("delete_variable needs something to delete", async () => {
    const payload = await deleteVariableTool.handler(client, {});
    assert.equal(payload.ok, false);
    assert.match(String(payload.error), /nothing to delete/);
  });

  test("every tool call carries an id the plugin can match on", async () => {
    const before = plugin.requests.length;
    await listCollectionsTool.handler(client, {});
    const request = plugin.requests[before];
    assert.equal(request.type, "request");
    assert.equal(request.method, "list_collections");
    assert.ok(request.id);
  });
});

describe("tools without a plugin", () => {
  test("status is the only tool that works with the panel closed", async () => {
    const bridge = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
    await bridge.start();
    const client = new PluginClient(bridge);

    const payload = await statusTool.handler(client, {});
    assert.equal(payload.ok, true);
    assert.equal(payload.connected, false);
    assert.match(String(payload.hint), /open the Elf Bridge plugin in Figma/);

    const calls = [
      () => listCollectionsTool.handler(client, {}),
      () => listVariablesTool.handler(client, { collection: "Core" }),
      () => createCollectionTool.handler(client, { name: "Core" }),
      () => upsertVariablesTool.handler(client, { collection: "Core", variables: [] }),
      () => renameVariableTool.handler(client, { name: "color/primary/base", newName: "x" }),
      () => deleteVariableTool.handler(client, { names: ["space/4"] }),
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