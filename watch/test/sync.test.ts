import assert from "node:assert/strict";
import { test } from "node:test";
import { loadManifest, saveManifest } from "../../batch/src/manifest.js";
import { syncChanges } from "../src/sync.js";
import { FakeBridge, scratchProject, writeSidecar, writeTokens } from "./helpers.js";

test("fresh sync pushes tokens and components once", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    const summary = await syncChanges({
      config: scratch.config,
      bridge,
      tokensChanged: true,
    });

    assert.equal(summary.tokens, 4);
    assert.equal(summary.components, 2);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Icon", "Button"]);
    assert.equal(bridge.callsTo("upsert_variables")[0]?.params.collection, "Primitives");
    assert.equal((bridge.callsTo("upsert_variables")[0]?.params.variables as unknown[]).length, 4);

    const manifest = loadManifest(scratch.config.manifestFile);
    assert.equal(Object.keys(manifest.tokens).length, 4);
    assert.equal(Object.keys(manifest.components).length, 2);
  } finally {
    scratch.cleanup();
  }
});

test("a component-only change pushes just that component", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    bridge.calls.length = 0;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });

    assert.equal(summary.components, 1);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Button"]);
    assert.equal(bridge.callsTo("upsert_variables").length, 0);
  } finally {
    scratch.cleanup();
  }
});

test("changing a dependency re-syncs its dependents too", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    bridge.calls.length = 0;
    writeSidecar(scratch, "Icon", {
      size: { width: 20, height: 20 },
      fill: "color.primary.500",
    });

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });

    assert.equal(summary.components, 2);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Icon", "Button"]);
  } finally {
    scratch.cleanup();
  }
});

test("a missing dependency is synced before its changed dependent", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    const manifest = loadManifest(scratch.config.manifestFile);
    delete manifest.components["Icon.tsx#Icon"];
    saveManifest(scratch.config.manifestFile, manifest);
    bridge.calls.length = 0;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });

    assert.equal(summary.components, 2);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Icon", "Button"]);
  } finally {
    scratch.cleanup();
  }
});

test("a dependency whose Figma node disappeared is re-created", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    const iconNode = loadManifest(scratch.config.manifestFile).components["Icon.tsx#Icon"]?.figmaNodeId;
    assert.ok(iconNode);
    bridge.missingNodes.add(iconNode);
    bridge.calls.length = 0;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });

    assert.equal(summary.components, 2);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Icon", "Button"]);
  } finally {
    scratch.cleanup();
  }
});

test("a selected component whose Figma node disappeared is re-created", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    const buttonNode = loadManifest(scratch.config.manifestFile).components["Button.tsx#Button"]?.figmaNodeId;
    assert.ok(buttonNode);
    bridge.missingNodes.add(buttonNode);
    bridge.calls.length = 0;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });

    assert.equal(summary.components, 1);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Button"]);
    assert.deepEqual(summary.conflicts, []);
  } finally {
    scratch.cleanup();
  }
});

test("a Figma-side change is skipped unless forced once", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    bridge.calls.length = 0;
    bridge.nodeWidth = 200;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    const blocked = await syncChanges({ config: scratch.config, bridge, tokensChanged: false });
    assert.deepEqual(blocked.conflicts, ["Button"]);
    assert.equal(blocked.components, 0);
    assert.deepEqual(bridge.componentNames("upsert_component"), []);

    const force = new Set(["Button"]);
    const forced = await syncChanges({
      config: scratch.config,
      bridge,
      tokensChanged: false,
      forceComponents: force,
    });
    assert.equal(forced.components, 1);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Button"]);
    assert.equal(force.size, 0);
  } finally {
    scratch.cleanup();
  }
});

test("stopping between chunks keeps completed work", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  let checks = 0;
  try {
    const summary = await syncChanges({
      config: scratch.config,
      bridge,
      tokensChanged: true,
      stopping: () => checks++ > 0,
    });

    assert.equal(summary.components, 1);
    assert.ok(summary.aborted);
    const manifest = loadManifest(scratch.config.manifestFile);
    assert.equal(manifest.components["Icon.tsx#Icon"]?.status, "synced");
    assert.equal(manifest.components["Button.tsx#Button"], undefined);
  } finally {
    scratch.cleanup();
  }
});

test("a token change upserts only the changed variable", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  try {
    await syncChanges({ config: scratch.config, bridge, tokensChanged: true });
    bridge.calls.length = 0;
    const tokens = {
      color: {
        primary: { "500": { value: "#111827", type: "color" } },
        surface: { base: { value: "#ffffff", type: "color" } },
      },
      space: {
        "2": { value: 8, type: "dimension" },
        "4": { value: 16, type: "dimension" },
      },
    };
    writeTokens(scratch, tokens);

    const summary = await syncChanges({ config: scratch.config, bridge, tokensChanged: true });

    assert.equal(summary.tokens, 1);
    assert.equal(summary.components, 0);
    const upsert = bridge.callsTo("upsert_variables");
    assert.equal(upsert.length, 1);
    assert.equal((upsert[0]?.params.variables as unknown[]).length, 1);
  } finally {
    scratch.cleanup();
  }
});
