import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { loadManifest } from "../src/manifest.js";
import { NODE_STATE_DEPTH } from "../src/nodestate.js";
import { planComponents, runSync } from "../src/sync.js";
import { planTokens } from "../src/tokens.js";
import { FakeBridge, scratchFixtures, type Scratch } from "./helpers.js";

const silent = (): void => undefined;

function actions(result: Awaited<ReturnType<typeof runSync>>): [string, string][] {
  return result.components.map((component) => [component.name, component.action]);
}

async function fullRun(scratch: Scratch, bridge: FakeBridge): Promise<string[]> {
  const logs: string[] = [];
  await runSync({ config: scratch.config, client: bridge, log: (line) => logs.push(line) });
  return logs;
}

describe("runSync", () => {
  test("a fresh run syncs tokens, then components in dependency order", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    const logs = await fullRun(scratch, bridge);

    assert.deepEqual(bridge.callsTo("create_collection").map((call) => call.params.name), [
      "Primitives",
      "Semantic",
    ]);
    const variableCalls = bridge.callsTo("upsert_variables");
    assert.equal(variableCalls[0]?.params.collection, "Primitives");
    assert.equal((variableCalls[0]?.params.variables as unknown[]).length, 8);
    assert.equal(variableCalls[0]?.params.defaultMode, "Value");
    assert.equal(variableCalls[1]?.params.collection, "Semantic");
    assert.equal((variableCalls[1]?.params.variables as unknown[]).length, 2);
    assert.equal(variableCalls[1]?.params.defaultMode, "Light");

    assert.deepEqual(bridge.componentNames("upsert_component"), ["Badge", "Card", "Divider", "Footer", "Icon"]);
    assert.deepEqual(bridge.componentNames("upsert_component_set"), ["Alert", "Button", "Status"]);
    assert.deepEqual(
      bridge.methods().filter((method) => method.startsWith("upsert_component")),
      [
        "upsert_component",
        "upsert_component",
        "upsert_component",
        "upsert_component",
        "upsert_component",
        "upsert_component_set",
        "upsert_component_set",
        "upsert_component_set",
      ],
      "components sync leaves-first",
    );
    assert.equal(bridge.callsTo("upsert_text_style").length, 1);
    assert.equal(bridge.callsTo("upsert_effect_style").length, 1);

    const manifest = loadManifest(scratch.config.manifestFile);
    assert.deepEqual(
      Object.values(manifest.components).map((entry) => entry.status),
      ["synced", "synced", "synced", "synced", "synced", "synced", "synced", "synced"],
    );
    assert.equal(Object.keys(manifest.tokens).length, 10);
    assert.ok(manifest.tokens["color.primary.500"]?.figmaVariableId?.startsWith("V:"));
    assert.equal(Object.keys(manifest.tokens).includes("Body/Regular"), false, "styles are not tracked");

    assert.ok(logs.some((line) => line.includes("manifest written (5/8)")), "first chunk persisted");
    assert.ok(logs.some((line) => line.includes("manifest written (8/8)")), "last chunk persisted");
    scratch.cleanup();
  });

  test("variant sets carry the matrix and per-variant overrides", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    await fullRun(scratch, bridge);

    const button = bridge.callsTo("upsert_component_set").find((call) => call.params.name === "Button");
    assert.ok(button);
    const variants = button.params.variants as { props: Record<string, string>; spec?: unknown }[];
    assert.equal(variants.length, 4);
    assert.deepEqual(variants[0], {
      props: { size: "sm", intent: "primary" },
      spec: { padding: { all: { variable: "space/2" } } },
    });
    assert.deepEqual(variants[1], { props: { size: "sm", intent: "secondary" } });
    assert.deepEqual(variants[3], {
      props: { size: "md", intent: "secondary" },
      spec: { fill: { variable: "color/surface/base" } },
    });
    assert.deepEqual(button.params.children, [{ type: "instance", component: "Icon.tsx#Icon" }]);

    const status = bridge.callsTo("upsert_component_set").find((call) => call.params.name === "Status");
    const statusVariants = status?.params.variants as { props: Record<string, string>; spec?: unknown }[];
    assert.deepEqual(statusVariants, [
      { props: { tone: "positive" }, spec: { fill: { variable: "color/primary/500" } } },
      { props: { tone: "negative" }, spec: { fill: { variable: "color/onSurface/base" } } },
    ]);

    const card = bridge.callsTo("upsert_component").find((call) => call.params.name === "Card");
    assert.deepEqual(card?.params.children, [{ type: "instance", component: "Badge.vue#Badge" }]);

    const footer = bridge.callsTo("upsert_component").find((call) => call.params.name === "Footer");
    assert.deepEqual(footer?.params.children, [{ type: "instance", component: "Divider.jsx#Divider" }]);
    scratch.cleanup();
  });

  test("a re-run skips everything unchanged — except styles, which re-upsert", async () => {
    const scratch = scratchFixtures();
    await fullRun(scratch, new FakeBridge());

    const bridge = new FakeBridge();
    const logs: string[] = [];
    const result = await runSync({ config: scratch.config, client: bridge, log: (line) => logs.push(line) });

    assert.deepEqual(actions(result), [
      ["Badge", "unchanged"],
      ["Card", "unchanged"],
      ["Divider", "unchanged"],
      ["Footer", "unchanged"],
      ["Icon", "unchanged"],
      ["Alert", "unchanged"],
      ["Button", "unchanged"],
      ["Status", "unchanged"],
    ]);
    assert.deepEqual(bridge.componentNames("upsert_component"), []);
    assert.deepEqual(bridge.componentNames("upsert_component_set"), []);
    assert.deepEqual(bridge.callsTo("create_collection"), []);
    assert.deepEqual(bridge.callsTo("upsert_variables"), []);
    assert.equal(bridge.callsTo("upsert_text_style").length, 1, "styles re-upsert every run");
    assert.equal(bridge.callsTo("upsert_effect_style").length, 1);
    assert.ok(logs.some((line) => line.includes("no changes")));
    scratch.cleanup();
  });

  test("--force re-syncs everything", async () => {
    const scratch = scratchFixtures();
    await fullRun(scratch, new FakeBridge());

    const bridge = new FakeBridge();
    const result = await runSync({ config: scratch.config, client: bridge, force: true, log: silent });
    assert.ok(result.components.every((component) => component.action === "synced"));
    assert.equal(bridge.callsTo("upsert_component").length, 5);
    assert.equal(bridge.callsTo("upsert_component_set").length, 3);
    scratch.cleanup();
  });

  test("a crash between chunks resumes from the manifest", async () => {
    const scratch = scratchFixtures();
    const first = new FakeBridge();
    first.failNames.add("Badge");
    const logs: string[] = [];
    const crashed = await runSync({
      config: scratch.config,
      client: first,
      chunkSize: 2,
      log: (line) => logs.push(line),
    });

    assert.deepEqual(actions(crashed), [
      ["Badge", "failed"],
      ["Card", "skipped"],
      ["Divider", "synced"],
      ["Footer", "synced"],
      ["Icon", "synced"],
      ["Alert", "synced"],
      ["Button", "synced"],
      ["Status", "synced"],
    ]);
    const kept = loadManifest(scratch.config.manifestFile);
    assert.equal(kept.components["Badge.vue#Badge"]?.status, "failed");
    assert.equal(kept.components["Card.vue#Card"]?.status, "skipped");
    assert.equal(kept.components["Status.svelte#Status"]?.status, "synced");
    assert.ok(logs.some((line) => line.includes("manifest written (4/8)")), "chunks before the crash persisted");

    const second = new FakeBridge();
    const resumed = await runSync({ config: scratch.config, client: second, log: silent });
    assert.deepEqual(actions(resumed), [
      ["Badge", "synced"],
      ["Card", "synced"],
      ["Divider", "unchanged"],
      ["Footer", "unchanged"],
      ["Icon", "unchanged"],
      ["Alert", "unchanged"],
      ["Button", "unchanged"],
      ["Status", "unchanged"],
    ]);
    assert.deepEqual(second.componentNames("upsert_component"), ["Badge", "Card"]);
    assert.deepEqual(second.componentNames("upsert_component_set"), []);
    const fixed = loadManifest(scratch.config.manifestFile);
    assert.equal(fixed.components["Card.vue#Card"]?.status, "synced");
    scratch.cleanup();
  });

  test("a missing sidecar fails that component and skips its dependents", async () => {
    const scratch = scratchFixtures();
    rmSync(join(scratch.componentsDir, "Badge.figma.json"));

    const bridge = new FakeBridge();
    const result = await runSync({ config: scratch.config, client: bridge, log: silent });
    assert.deepEqual(actions(result), [
      ["Badge", "failed"],
      ["Card", "skipped"],
      ["Divider", "synced"],
      ["Footer", "synced"],
      ["Icon", "synced"],
      ["Alert", "synced"],
      ["Button", "synced"],
      ["Status", "synced"],
    ]);
    assert.match(result.components[0]?.error ?? "", /Missing sidecar/);
    assert.match(result.components[1]?.error ?? "", /Depends on Badge \(failed\)/);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Divider", "Footer", "Icon"]);
    scratch.cleanup();
  });

  test("editing one sidecar re-syncs only that component", async () => {
    const scratch = scratchFixtures();
    await fullRun(scratch, new FakeBridge());

    const sidecarPath = join(scratch.componentsDir, "Badge.figma.json");
    const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    sidecar.fill = "color.onSurface.base";
    writeFileSync(sidecarPath, JSON.stringify(sidecar));

    const bridge = new FakeBridge();
    const result = await runSync({ config: scratch.config, client: bridge, log: silent });
    assert.deepEqual(actions(result), [
      ["Badge", "synced"],
      ["Card", "unchanged"],
      ["Divider", "unchanged"],
      ["Footer", "unchanged"],
      ["Icon", "unchanged"],
      ["Alert", "unchanged"],
      ["Button", "unchanged"],
      ["Status", "unchanged"],
    ]);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Badge"]);
    scratch.cleanup();
  });

  test("--only syncs the component and its dependencies", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    const result = await runSync({ config: scratch.config, client: bridge, only: "Button", log: silent });

    assert.deepEqual(actions(result), [
      ["Icon", "synced"],
      ["Button", "synced"],
    ]);
    assert.deepEqual(bridge.componentNames("upsert_component"), ["Icon"]);
    assert.deepEqual(bridge.componentNames("upsert_component_set"), ["Button"]);
    assert.equal(bridge.callsTo("upsert_variables").length, 2, "tokens always sync fully");
    scratch.cleanup();
  });

  test("--only with an unknown name names the known components", async () => {
    const scratch = scratchFixtures();
    const { index } = planTokens(scratch.config.tokensFile, scratch.config);
    assert.throws(
      () => planComponents(scratch.config, index, "Nope"),
      /No component matches "--only Nope". Known components: Alert, Badge, Button, Card, Divider, Footer, Icon, Status./,
    );
    scratch.cleanup();
  });

  test("dry-run plans everything but writes nothing and calls nothing", async () => {
    const scratch = scratchFixtures();
    const logs: string[] = [];
    const result = await runSync({ config: scratch.config, client: null, log: (line) => logs.push(line) });

    assert.equal(result.dryRun, true);
    assert.equal(result.aborted, undefined);
    assert.deepEqual(actions(result), [
      ["Badge", "synced"],
      ["Card", "synced"],
      ["Divider", "synced"],
      ["Footer", "synced"],
      ["Icon", "synced"],
      ["Alert", "synced"],
      ["Button", "synced"],
      ["Status", "synced"],
    ]);
    assert.equal(result.tokens.primitives.planned, 8);
    assert.equal(existsSync(scratch.config.manifestFile), false, "dry-run must not create a manifest");
    assert.ok(logs.some((line) => line.includes("would upsert 8 variable(s)")));
    assert.ok(logs.some((line) => line.includes("manifest written")), "dry-run still reports progress");
    scratch.cleanup();
  });

  test("a Figma-level variable refusal aborts before any component", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    bridge.variableErrors = [{ name: "color/primary/500", message: "plan limit" }];
    const result = await runSync({ config: scratch.config, client: bridge, log: silent });

    assert.match(result.aborted ?? "", /Figma refused 1 variable\(s\) in "Primitives": color\/primary\/500: plan limit/);
    assert.deepEqual(result.components, []);
    assert.deepEqual(bridge.componentNames("upsert_component"), []);
    assert.deepEqual(bridge.componentNames("upsert_component_set"), []);
    assert.equal(bridge.callsTo("upsert_text_style").length, 0, "styles wait for a healthy token phase");
    scratch.cleanup();
  });

  test("a mid-token crash keeps what already synced, and resume skips it", async () => {
    const scratch = scratchFixtures();
    const first = new FakeBridge();
    first.failNames.add("Semantic");
    const crashed = await runSync({ config: scratch.config, client: first, log: silent });

    assert.match(crashed.aborted ?? "", /Bridge call failed during tokens/);
    assert.deepEqual(crashed.components, []);
    const kept = loadManifest(scratch.config.manifestFile);
    assert.equal(Object.keys(kept.tokens).length, 8, "already-synced primitives were kept in the manifest");

    const second = new FakeBridge();
    const resumed = await runSync({ config: scratch.config, client: second, log: silent });
    assert.deepEqual(
      second.callsTo("create_collection").map((call) => call.params.name),
      ["Semantic"],
      "the primitives collection is skipped on resume",
    );
    assert.ok(resumed.components.every((component) => component.action === "synced"));
    scratch.cleanup();
  });

  test("a bridge failure during the token phase aborts with the call context", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    bridge.failMethods.set("upsert_variables", "boom");
    const result = await runSync({ config: scratch.config, client: bridge, log: silent });
    assert.match(result.aborted ?? "", /Bridge call failed during tokens: boom/);
    assert.deepEqual(result.components, []);
    scratch.cleanup();
  });

  test("every synced component records a nodeHash read back from Figma", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    await fullRun(scratch, bridge);

    const manifest = loadManifest(scratch.config.manifestFile);
    const entries = Object.entries(manifest.components);
    assert.equal(entries.length, 8);
    for (const [codeKey, entry] of entries) {
      assert.equal(entry.status, "synced");
      assert.match(entry.nodeHash ?? "", /^[0-9a-f]{16}$/, `${codeKey} carries a 16-char node hash`);
    }
    // One read per synced component, asking for the shared depth.
    assert.equal(bridge.callsTo("get_node").length, 8);
    for (const call of bridge.callsTo("get_node")) {
      assert.equal(call.params.depth, NODE_STATE_DEPTH);
    }
    scratch.cleanup();
  });

  test("a failed node-state read keeps the sync, leaving nodeHash null", async () => {
    const scratch = scratchFixtures();
    const bridge = new FakeBridge();
    bridge.failMethods.set("get_node", "node gone");
    const logs = await fullRun(scratch, bridge);

    const manifest = loadManifest(scratch.config.manifestFile);
    for (const entry of Object.values(manifest.components)) {
      assert.equal(entry.status, "synced", "the component itself synced fine");
      assert.equal(entry.nodeHash, null);
    }
    assert.ok(logs.some((line) => line.includes("reading the node state failed")));
    scratch.cleanup();
  });
});
