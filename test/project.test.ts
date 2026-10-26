import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectService } from "../src/project.js";
import type { BridgeRuntime } from "../mcp/src/runtime.js";

function project(components = false) {
  const root = mkdtempSync(join(tmpdir(), "elf-managed-project-")); const path = join(root, "elf.config.json");
  writeFileSync(join(root, "tokens.css"), ":root { --color-primary: #112233; }");
  if (components) {
    mkdirSync(join(root, "components"));
    writeFileSync(join(root, "components", "Button.tsx"), "export function Button() { return <button>Save</button>; }");
    writeFileSync(join(root, "components", "Button.figma.json"), JSON.stringify({ size: { width: 120, height: 40 }, text: { characters: "Save", fontSize: 14 } }));
  }
  writeFileSync(path, JSON.stringify({ figma: { fileKey: "project-file", source: "bridge" }, codebase: { path: "tokens.css", source: "css" }, ...(components ? { components: { path: "components", manifest: "elf.manifest.json" } } : {}) }));
  const variables: any[] = []; const refs: any[] = []; const nodes: Record<string, any> = {}; const calls: string[] = [];
  const race = { enabled: false };
  const client = { async call(method: string, params: any = {}): Promise<any> {
    calls.push(method);
    if (method === "list_collections") return { collections: [] };
    if (method === "list_variables") return { variables: variables.map(item => ({ ...item })) };
    if (method === "list_components") return { components: refs };
    if (method === "get_node") return { node: nodes[params.nodeId] };
    if (method === "create_collection") return { collection: { id: "collection" } };
    if (method === "upsert_variables") {
      const stored = params.variables.map((input: any) => {
        let item = variables.find(item => item.codeKey === input.codeKey);
        if (!item) { item = { id: `var-${variables.length}` }; variables.push(item); }
        Object.assign(item, input, { collectionName: params.collection, valuesByMode: Object.fromEntries(Object.entries(input.values).map(([mode, value]) => [mode, { type: input.type, value }])) });
        if (race.enabled) item.valuesByMode.Value.value = "#abcdef";
        return { id: item.id, name: item.name, action: "updated" };
      });
      return { variables: stored, errors: [] };
    }
    if (method === "upsert_component" || method === "upsert_component_set") {
      let ref = refs.find(item => item.codeKey === params.codeKey);
      if (!ref) { ref = { id: `node-${refs.length}`, name: params.name, codeKey: params.codeKey }; refs.push(ref); }
      nodes[ref.id] = { ...ref, type: method === "upsert_component_set" ? "COMPONENT_SET" : "COMPONENT", width: params.size?.width ?? 120, height: 40, children: params.text ? [{ type: "TEXT", characters: params.text.characters, fontSize: params.text.fontSize }] : [] };
            if (method === "upsert_component_set") {
        nodes[ref.id].children = params.variants.map((variant: any) => {
          const spec = { ...params, ...variant.spec };
          return { type: "COMPONENT", name: Object.entries(variant.props).map(([key, value]) => `${key}=${value}`).join(", "), width: spec.size?.width ?? 120, height: spec.size?.height ?? 40, children: spec.text ? [{ type: "TEXT", characters: spec.text.characters, fontSize: spec.text.fontSize }] : [] };
        });
        return { set: { id: ref.id, created: true } };
      }
      return { component: { id: ref.id, created: true } };
    }
    throw new Error(`Unexpected ${method}`);
  } };
  const runtime = { transaction: async (file: string, work: (client: any) => any) => { assert.equal(file, "project-file"); return work(client); }, connection: { status: { file: { key: "project-file" } } } } as unknown as BridgeRuntime;
  return { root, path, variables, refs, nodes, calls, race, service: new ProjectService(path, runtime), cleanup: () => rmSync(root, { recursive: true }) };
}

test("managed plans reject changed code and only enable auto after a fresh reviewed apply", async () => {
  const p = project();
  try {
    const stale = await p.service.plan();
    assert.equal(stale.entries.length, 1);
    assert.equal(p.calls.some(call => call.startsWith("upsert")), false);
    writeFileSync(join(p.root, "tokens.css"), ":root { --color-primary: #334455; }");
    await assert.rejects(p.service.apply(stale.id), /changed after review/);
    assert.equal(p.calls.some(call => call.startsWith("upsert")), false);
    const fresh = await p.service.plan();
    assert.equal((await p.service.apply(fresh.id, { enableAuto: true })).synced, 1);
    assert.equal(p.service.automatic(), true);
    await assert.rejects(p.service.apply(fresh.id), /expired/);
    const baseline = JSON.parse(readFileSync(join(p.root, "elf.manifest.json"), "utf8"));
    assert.ok(baseline.tokens["color-primary"].remoteHash);
    assert.equal((await p.service.plan()).entries.length, 0);
    p.service.setMonitoring(); assert.equal(p.service.automatic(), false);
  } finally { p.cleanup(); }
});

test("automatic sync preserves Figma edits and requires explicit reviewed conflict replacement", async () => {
  const p = project();
  try {
    const plan = await p.service.plan(); await p.service.apply(plan.id, { enableAuto: true });
    p.variables[0].values = { Value: "#abcdef" };
    writeFileSync(join(p.root, "tokens.css"), ":root { --color-primary: #445566; }");
    const before = p.calls.filter(call => call.startsWith("upsert")).length;
    assert.equal((await p.service.autoSync()).paused, true);
    assert.equal(p.calls.filter(call => call.startsWith("upsert")).length, before);
    const conflict = await p.service.plan(); assert.ok(conflict.issues.some(issue => issue.kind === "conflict"));
    await assert.rejects(p.service.apply(conflict.id), /Figma has edits/);
    await p.service.apply(conflict.id, { overwriteConflicts: true });
    assert.equal((await p.service.plan()).issues.length, 0);
    writeFileSync(join(p.root, "tokens.css"), ":root {}");
    const removed = await p.service.plan(); assert.ok(removed.issues.some(issue => issue.kind === "removed"));
    assert.equal((await p.service.autoSync()).paused, true);
    assert.equal(p.variables.length, 1);
  } finally { p.cleanup(); }
});

test("implementation edits require description review and managed creation records source baselines", async () => {
  const p = project(true);
  try {
    const initial = await p.service.plan(); await p.service.apply(initial.id);
    const source = join(p.root, "components", "Button.tsx");
    writeFileSync(source, "export function Button() { return <button className='new-size'>Save</button>; }");
    const changed = await p.service.plan();
    assert.ok(changed.issues.some(issue => issue.kind === "unsupported" && issue.message.includes("implementation changed")));
    assert.equal(changed.entries.some(entry => entry.kind === "component"), false);
    const prepared = await p.service.prepareComponent("Button"); assert.equal(prepared.reviewRequired, true);
    await p.service.saveDescription("Button", { size: { width: 140, height: 40 }, text: { characters: "Save", fontSize: 14 } });
    const reviewed = await p.service.plan(); assert.ok(reviewed.entries.some(entry => entry.kind === "component"));
    await p.service.apply(reviewed.id);
    assert.ok(JSON.parse(readFileSync(join(p.root, "elf.manifest.json"), "utf8")).components["Button.tsx#Button"].sourceHash);
  } finally { p.cleanup(); }
});

test("old batch configuration migrates into the shared project config without losing fields", () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root, "tokens.json"), "{}");
    writeFileSync(join(p.root, "elf-batch.config.json"), JSON.stringify({ tokens: "tokens.json", components: "components", chunkSize: 3 }));
    const raw = JSON.parse(readFileSync(p.path, "utf8")); raw.custom = { keep: true }; writeFileSync(p.path, JSON.stringify(raw));
    new ProjectService(p.path, {} as BridgeRuntime);
    const migrated = JSON.parse(readFileSync(p.path, "utf8"));
    assert.equal(migrated.sync.tokens, "tokens.json"); assert.equal(migrated.sync.chunkSize, 3); assert.equal(migrated.custom.keep, true);
  } finally { p.cleanup(); }
});

test("edits made during a write cannot be silently adopted as a trusted sync baseline", async () => {
  const p = project();
  try {
    const plan = await p.service.plan(); p.race.enabled = true;
    await assert.rejects(p.service.apply(plan.id, { enableAuto: true }), /changed while syncing/);
    assert.equal(p.variables[0].valuesByMode.Value.value, "#abcdef");
    assert.equal(p.service.automatic(), false);
    const next = await p.service.plan();
    assert.ok(next.issues.some(issue => issue.kind === "conflict"));
    assert.equal(JSON.parse(readFileSync(join(p.root, "elf.manifest.json"), "utf8")).tokens["color-primary"].remoteHash, undefined);
  } finally { p.cleanup(); }
});

test("managed component sets remain linked and roster changes require explicit review", async () => {
  const p = project(true);
  const source = join(p.root, "components", "Button.tsx");
  try {
    writeFileSync(source, 'interface Props { size: "sm" | "md" } export function Button() { return <button>Save</button>; }');
    const plan = await p.service.plan(); await p.service.apply(plan.id, { enableAuto: true });
    assert.equal((await p.service.plan()).entries.length, 0);
    assert.equal((await p.service.plan()).issues.length, 0);
    writeFileSync(source, 'interface Props { size: "sm" | "md" | "lg" } export function Button() { return <button>Save</button>; }');
    const changed = await p.service.plan();
    assert.ok(changed.issues.some(issue => issue.message.includes("detaches existing instances")));
    assert.equal((await p.service.autoSync()).paused, true);
    await p.service.apply(changed.id, { overwriteConflicts: true });
    assert.equal(p.nodes[p.refs[0].id].children.length, 3);
  } finally { p.cleanup(); }
});

import { SyncAlerts } from "../src/sync-alerts.js";
test("sync alerts deduplicate across restarts and only persist successful delivery", async () => {
  const p = project(); let sent = 0;
  try {
    const deliver = async () => { sent += 1; };
    await new SyncAlerts(p.path).update("issue-one", deliver);
    await new SyncAlerts(p.path).update("issue-one", deliver);
    assert.equal(sent, 1);
    await assert.rejects(new SyncAlerts(p.path).update("issue-two", async () => { throw new Error("delivery failed"); }), /delivery failed/);
    await new SyncAlerts(p.path).update("issue-two", deliver); assert.equal(sent, 2);
    await new SyncAlerts(p.path).update(null);
    await new SyncAlerts(p.path).update("issue-two", deliver); assert.equal(sent, 3);
  } finally { p.cleanup(); }
});
