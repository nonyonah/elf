import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FakeBridge, scratchFixtures, type Scratch } from "../batch/test/helpers.js";
import { loadManifest } from "../batch/src/manifest.js";
import { runSync } from "../batch/src/sync.js";
import { diffComponents } from "../src/components.js";
import type { BridgeCaller } from "../src/figma/bridge.js";

const silent = (): void => undefined;

/** Mirrors the batch FakeBridge node shape — but at a different x/y, to prove
 * the node hash ignores position (batch hashed it at x:10, y:20). */
function nodeFor(nodeId: string, width = 100): Record<string, unknown> {
  return {
    id: nodeId,
    name: "Fake",
    type: "COMPONENT",
    codeKey: null,
    layoutMode: "NONE",
    width,
    height: 40,
    x: 111,
    y: 222,
    itemSpacing: 0,
    paddingTop: 0,
    paddingRight: 0,
    paddingBottom: 0,
    paddingLeft: 0,
    cornerRadius: 0,
    fills: [],
    boundVariables: {},
    children: [],
  };
}

interface FigmaRef {
  id: string;
  name: string;
  codeKey: string | null;
}

class ComponentBridge implements BridgeCaller {
  missingNodes = new Set<string>();
  private readonly widths = new Map<string, number>();

  constructor(private readonly components: FigmaRef[]) {}

  setWidth(nodeId: string, width: number): void {
    this.widths.set(nodeId, width);
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === "list_components") {
      return { components: this.components } as T;
    }
    if (method === "get_node") {
      const nodeId = String(params.nodeId);
      if (this.missingNodes.has(nodeId)) throw new Error(`Node ${nodeId} not found`);
      return { node: nodeFor(nodeId, this.widths.get(nodeId) ?? 100) } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  close(): void {
    undefined;
  }
}

function figmaRefs(manifestPath: string): FigmaRef[] {
  const manifest = loadManifest(manifestPath);
  return Object.entries(manifest.components).map(([codeKey, entry]) => ({
    id: entry.figmaNodeId ?? "",
    name: codeKey.split("#")[1] ?? codeKey,
    codeKey,
  }));
}

async function syncedScratch(): Promise<Scratch> {
  const scratch = scratchFixtures();
  await runSync({ config: scratch.config, client: new FakeBridge(), log: silent });
  return scratch;
}

function editBadgeSidecar(scratch: Scratch): void {
  const sidecarPath = join(scratch.componentsDir, "Badge.figma.json");
  const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
  sidecar.fill = "color.onSurface.base";
  writeFileSync(sidecarPath, JSON.stringify(sidecar));
}

test("a freshly synced repo shows no component drift", async () => {
  const scratch = await syncedScratch();
  const bridge = new ComponentBridge(figmaRefs(scratch.config.manifestFile));

  const diff = await diffComponents(scratch.componentsDir, scratch.config.manifestFile, bridge);

  assert.equal(diff.outOfDate.length, 0);
  assert.equal(diff.changedInFigma.length, 0);
  assert.equal(diff.inCodeNotInFigma.length, 0);
  assert.equal(diff.inFigmaNotInCode.length, 0);
  assert.equal(diff.codeComponents.length, 8);
  assert.equal(diff.figmaCodeKeys.size, 8);
  scratch.cleanup();
});

test("a changed sidecar marks only that component out of date", async () => {
  const scratch = await syncedScratch();
  editBadgeSidecar(scratch);
  const bridge = new ComponentBridge(figmaRefs(scratch.config.manifestFile));

  const diff = await diffComponents(scratch.componentsDir, scratch.config.manifestFile, bridge);

  assert.deepEqual(diff.outOfDate.map((issue) => issue.name), ["Badge"]);
  assert.equal(diff.outOfDate[0]?.file, "Badge.vue");
  assert.match(diff.outOfDate[0]?.detail ?? "", /re-run elf-batch/);
  assert.equal(diff.changedInFigma.length, 0);
  scratch.cleanup();
});

test("a node that changed in Figma wins the report when both sides moved", async () => {
  const scratch = await syncedScratch();
  const badgeNode = loadManifest(scratch.config.manifestFile).components["Badge.vue#Badge"]?.figmaNodeId;
  assert.ok(badgeNode);
  editBadgeSidecar(scratch);
  const bridge = new ComponentBridge(figmaRefs(scratch.config.manifestFile));
  bridge.setWidth(badgeNode, 200);

  const diff = await diffComponents(scratch.componentsDir, scratch.config.manifestFile, bridge);

  assert.deepEqual(diff.changedInFigma.map((issue) => issue.name), ["Badge"]);
  assert.match(diff.changedInFigma[0]?.detail ?? "", /the code spec also changed/);
  assert.equal(diff.outOfDate.length, 0, "no double count");
  scratch.cleanup();
});

test("a deleted Figma node counts as changed in Figma", async () => {
  const scratch = await syncedScratch();
  const iconNode = loadManifest(scratch.config.manifestFile).components["Icon.tsx#Icon"]?.figmaNodeId;
  assert.ok(iconNode);
  const bridge = new ComponentBridge(figmaRefs(scratch.config.manifestFile));
  bridge.missingNodes.add(iconNode);

  const diff = await diffComponents(scratch.componentsDir, scratch.config.manifestFile, bridge);

  assert.deepEqual(diff.changedInFigma.map((issue) => issue.name), ["Icon"]);
  assert.match(diff.changedInFigma[0]?.detail ?? "", /no longer exists/);
  scratch.cleanup();
});

test("never-synced components and stale Figma nodes land in their own buckets", async () => {
  const scratch = await syncedScratch();
  const manifestPath = scratch.config.manifestFile;
  const syncedRefs = figmaRefs(manifestPath);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.components["Icon.tsx#Icon"];
  delete manifest.components["Button.tsx#Button"];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Button is still in Figma (just never recorded locally); Icon is in neither.
  const refs = syncedRefs.filter((ref) => ref.codeKey !== "Icon.tsx#Icon");
  refs.push({ id: "G:1", name: "Ghost", codeKey: "Ghost.tsx#Ghost" });
  const bridge = new ComponentBridge(refs);

  const diff = await diffComponents(scratch.componentsDir, manifestPath, bridge);

  assert.deepEqual(diff.inCodeNotInFigma.map((issue) => issue.name), ["Icon"]);
  assert.match(diff.inCodeNotInFigma[0]?.detail ?? "", /never synced by elf-batch/);
  assert.deepEqual(diff.outOfDate.map((issue) => issue.name), ["Button"]);
  assert.match(diff.outOfDate[0]?.detail ?? "", /in Figma but never synced by elf-batch/);
  assert.deepEqual(diff.inFigmaNotInCode.map((issue) => issue.name), ["Ghost"]);
  assert.equal(diff.inFigmaNotInCode[0]?.codeKey, "Ghost.tsx#Ghost");
  scratch.cleanup();
});
