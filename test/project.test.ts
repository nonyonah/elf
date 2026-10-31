import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  const collections: any[] = []; const variables: any[] = []; const refs: any[] = []; const nodes: Record<string, any> = {}; const calls: string[] = []; const nodeReads: string[] = [];
  const race = { enabled: false };
  const client = { async call(method: string, params: any = {}): Promise<any> {
    calls.push(method);
    if (method === "list_collections") return { collections };
    if (method === "list_variables") return { variables: variables.map(item => ({ ...item })) };
    if (method === "list_components") return { components: refs };
    if(method==='get_component_description') {const node=nodes[params.nodeId];return {nodeId:node.id,name:node.name,codeKey:node.codeKey??null,description:node.description??''};}
    if(method==='set_component_description') {const node=nodes[params.nodeId];if((node.description??'')!==params.expectedDescription||(node.codeKey??null)!==params.expectedCodeKey)throw new Error('Component documentation changed');node.description=params.description;return {nodeId:node.id,description:node.description};}
    if (method === "get_node") { nodeReads.push(params.nodeId); return { node: nodes[params.nodeId] }; }
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
  return { root, path, collections, variables, refs, nodes, calls, nodeReads, race, runtime, service: new ProjectService(path, runtime), cleanup: () => rmSync(root, { recursive: true }) };
}

test('component discovery and generated-draft validation never save or call Figma', async () => {
  const p = project(true);
  try {
    const listed = await p.service.listComponents();
    assert.equal((listed.components as any[])[0].name, 'Button');
    const prepared = await p.service.prepareComponent('Button');
    const before = readFileSync(join(p.root, 'components/Button.figma.json'), 'utf8');
    const valid = await p.service.validateDescription('Button', { fill: 'color-primary' }, prepared.reviewHash as string);
    assert.equal(valid.valid, true);
    const unresolved = await p.service.validateDescription('Button', { fill: 'invented-token' }, prepared.reviewHash as string);
    assert.equal(unresolved.valid,true);assert.equal(unresolved.syncReady,false);
    assert.equal(readFileSync(join(p.root, 'components/Button.figma.json'), 'utf8'), before);
    assert.equal(p.calls.length, 0);
    writeFileSync(join(p.root, 'components/Button.tsx'), 'export function Button(){return <button>Changed</button>}');
    await assert.rejects(p.service.validateDescription('Button', {}, prepared.reviewHash as string), /changed/);
  } finally { p.cleanup(); }
});

test('document approval requires explicit opt-in and matching pending file before changing strict configuration', async () => {
  const p = project(); const ticket = 'b'.repeat(64); const controlCalls: string[] = [];
  try {
    (p.service as any).runtime.control = async (method: string) => {controlCalls.push(method); return method === '__elf_document_pending' ? {file:{key:'project-file',name:'Open document'},ticket} : {ok:true};};
    const original = readFileSync(p.path,'utf8');
    await assert.rejects(p.service.approveDocument('project-file',ticket,false),/Explicit/);
    await assert.rejects(p.service.approveDocument('another-file',ticket,true),/changed/);
    assert.equal(readFileSync(p.path,'utf8'),original);
    await p.service.approveDocument('project-file',ticket,true);
    const updated = JSON.parse(readFileSync(p.path,'utf8'));
    assert.equal(updated.figma.authorization,'plugin'); assert.equal(updated.figma.source,'bridge');
    assert.equal(updated.runtime.autoSync,false);
    assert(controlCalls.includes('__elf_document_approve'));
    await p.service.useStrictAuthorization();
    assert.equal(JSON.parse(readFileSync(p.path,'utf8')).figma.authorization,'strict');
    assert(controlCalls.includes('__elf_require_strict'));
  } finally {p.cleanup();}
});

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

test("completed sync records before and after values and exposes live managed resources", async () => {
  const p = project();
  try {
    const plan = await p.service.plan(); await p.service.apply(plan.id);
    const first = p.service.activity.find(item => item.changes?.length)!;
    assert.equal(first.changes![0].before, null);
    assert.match(first.changes![0].after, /#112233/);
    const resources = await p.service.resources() as any;
    assert.equal(resources.resources.length, 1);
    assert.equal(resources.resources[0].verified, true);
    assert.match(resources.resources[0].value, /#112233/);
    writeFileSync(join(p.root, "tokens.css"), ":root { --color-primary: #334455; }");
    const next = await p.service.plan(); await p.service.apply(next.id);
    const updated = p.service.activity.find(item => item.changes?.length)!;
    assert.match(updated.changes![0].before!, /#112233/);
    assert.match(updated.changes![0].after, /#334455/);
    p.variables[0].valuesByMode.Value.value = "#abcdef";
    assert.equal(((await p.service.resources()) as any).resources[0].verified, false);
  } finally {p.cleanup();}
});

test("project monitoring discovers components without a configured folder", async () => {
  const p = project(true);
  try {
    const raw = JSON.parse(readFileSync(p.path, "utf8")); delete raw.components; raw.codebase = {path: "auto", source: "auto"}; writeFileSync(p.path, JSON.stringify(raw));
    const plan = await p.service.plan();
    assert.ok(plan.entries.some(item => item.key === "components/Button.tsx#Button"));
    assert.ok(p.service.watchPaths().includes(realpathSync(p.root)));
    assert.equal(p.calls.some(method => /upsert|create|delete/.test(method)), false);
  } finally {p.cleanup();}
});

test("deprecated resources are not recreated by managed sync", async () => {
  const p = project(true);
  try {
    const raw = JSON.parse(readFileSync(p.path, "utf8")); raw.deprecations = [{type: "component", name: "Button"}]; writeFileSync(p.path, JSON.stringify(raw));
    const plan = await p.service.plan();
    assert.ok(!plan.entries.some(item => item.name === "Button"));
    assert.ok(plan.issues.some(item => item.message.includes("deprecated")));
  } finally {p.cleanup();}
});

test("component drafts are actionable and stale code or descriptions cannot be acknowledged", async () => {
  const p = project(true);
  try {
    const sidecarPath = join(p.root, "components", "Button.figma.json");
    rmSync(sidecarPath);
    const plan = await p.service.plan();
    const issue = plan.issues.find(item => item.action === "prepare-component");
    assert.ok(issue?.component);
    const prepared = await p.service.prepareComponent(issue.component);
    assert.match(prepared.reviewHash as string, /^[a-f0-9]{64}$/);
    assert.equal(prepared.existing, false);
    assert.equal(p.calls.some(call => call.startsWith("upsert")), false);
    writeFileSync(join(p.root, "components", "Button.tsx"), "export function Button() { return <button>Changed</button>; }");
    await assert.rejects(p.service.saveDescription(issue.component, prepared.sidecar, prepared.reviewHash as string), /changed after preparation/);
    const next = await p.service.prepareComponent(issue.component);
    writeFileSync(sidecarPath, JSON.stringify({text: {characters: "Edited elsewhere"}}));
    await assert.rejects(p.service.saveDescription(issue.component, next.sidecar, next.reviewHash as string), /changed after preparation/);
    assert.equal(JSON.parse(readFileSync(sidecarPath, "utf8")).text.characters, "Edited elsewhere");
  } finally {p.cleanup();}
});

test("reviewing and saving a description preserves automatic mode without writing Figma inside the save", async () => {
  const p = project(true);
  try {
    await p.service.apply((await p.service.plan()).id, {enableAuto: true});
    const path = join(p.root, "components", "Button.figma.json");
    writeFileSync(path, "{ invalid description");
    const prepared = await p.service.prepareComponent("Button");
    assert.match(prepared.warning as string, /invalid/);
    assert.equal(readFileSync(path, "utf8"), "{ invalid description");
    const writes = p.calls.filter(call => /^(upsert|create|delete)/.test(call)).length;
    await p.service.saveDescription(prepared.codeKey as string, prepared.sidecar, prepared.reviewHash as string);
    assert.equal(p.service.automatic(), true);
    assert.equal(p.calls.filter(call => /^(upsert|create|delete)/.test(call)).length, writes);
    assert.equal((await p.service.plan()).issues.some(issue => issue.action === "prepare-component"), false);
  } finally {p.cleanup();}
});

test("preparation exposes unresolved token references without inventing replacements", async () => {
  const p = project(true);
  try {
    const sidecar = {fill: "color.not.in.this.project", text: {characters: "Save", fontSize: 14}};
    writeFileSync(join(p.root, "components", "Button.figma.json"), JSON.stringify(sidecar));
    const prepared = await p.service.prepareComponent("Button");
    assert.match(prepared.warning as string, /Review required/);
    assert.deepEqual(prepared.sidecar, sidecar);
    const saved = await p.service.saveDescription(prepared.codeKey as string, prepared.sidecar, prepared.reviewHash as string);
    assert.equal(saved.saved,true);assert.equal(saved.syncReady,false);
    assert.deepEqual(JSON.parse(readFileSync(join(p.root,'components','Button.figma.json'),'utf8')),sidecar);
    assert.equal((await p.service.plan()).issues.some(issue => issue.action === 'prepare-component'),true);
    assert.equal(p.calls.some(call => /^(upsert|create|delete)/.test(call)), false);
  } finally {p.cleanup();}
});

test("intentional differences pause automatic writes and require an explicit manual review", async () => {
  const p = project();
  try {
    await p.service.apply((await p.service.plan()).id, {enableAuto: true});
    const raw = JSON.parse(readFileSync(p.path, "utf8"));
    raw.intentionalDifferences = [{name: "color-primary", figmaValue: "#112233", codeValue: "#334455", reason: "Platform contrast"}];
    writeFileSync(p.path, JSON.stringify(raw));
    writeFileSync(join(p.root, "tokens.css"), ":root { --color-primary: #334455; }");
    const writes = p.calls.filter(call => /^(upsert|create|delete)/.test(call)).length;
    assert.equal((await p.service.autoSync()).paused, true);
    assert.equal(p.calls.filter(call => /^(upsert|create|delete)/.test(call)).length, writes);
    const plan = await p.service.plan();
    const enabled=await p.service.apply(plan.id, {enableAuto: true});
    assert.equal(enabled.synced,0);assert.equal(p.service.automatic(),true);
    assert.equal(p.variables[0].valuesByMode.Value.value,"#112233");
    await p.service.apply((await p.service.plan()).id);
    assert.equal(p.variables[0].valuesByMode.Value.value, "#334455");
  } finally {p.cleanup();}
});

test("an unrelated component type conflict does not force replacement when applying supported entries", async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root, "components", "Other.tsx"), 'export interface OtherProps { tone?: "info" | "danger"; } export function Other({tone}: OtherProps) { return <div>{tone}</div>; }');
    writeFileSync(join(p.root, "components", "Other.figma.json"), JSON.stringify({text: {characters: "Other", fontSize: 14}}));
    const existing = {id: "unrelated-node", name: "Other", codeKey: "Other.tsx#Other", type: "COMPONENT", width: 90, height: 40};
    p.refs.push({...existing}); p.nodes[existing.id] = {...existing};
    const plan = await p.service.plan();
    assert.ok(plan.issues.some(issue => issue.kind === "conflict" && issue.key === existing.codeKey));
    assert.equal(plan.entries.some(entry => entry.key === existing.codeKey), false);
    assert.ok(plan.entries.some(entry => entry.name === "Button"));
    await p.service.apply(plan.id);
    assert.deepEqual(p.nodes[existing.id], existing);
    assert.ok(p.refs.some(ref => ref.name === "Button"));
  } finally {p.cleanup();}
});

test("conflicts on a planned component dependency still require explicit replacement review", async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root, "components", "Button.tsx"), 'import {Other} from "./Other"; export function Button() { return <Other />; }');
    writeFileSync(join(p.root, "components", "Other.tsx"), 'export interface OtherProps { tone?: "info" | "danger"; } export function Other({tone}: OtherProps) { return <div>{tone}</div>; }');
    writeFileSync(join(p.root, "components", "Other.figma.json"), JSON.stringify({text: {characters: "Other", fontSize: 14}}));
    const existing = {id: "dependency-node", name: "Other", codeKey: "Other.tsx#Other", type: "COMPONENT", width: 90, height: 40};
    p.refs.push({...existing}); p.nodes[existing.id] = {...existing};
    const plan = await p.service.plan();
    assert.ok(plan.issues.some(issue => issue.key === existing.codeKey && issue.blocksApply === true));
    await assert.rejects(p.service.apply(plan.id), /Figma has edits/);
    assert.equal(p.calls.some(call => /^(upsert|create|delete)/.test(call)), false);
  } finally {p.cleanup();}
});


test('individual component sync includes only referenced tokens and rejects stale review and auto enable', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'tokens.css'), ':root { --color-primary: #112233; --color-unrelated: #abcdef; }');
    writeFileSync(join(p.root,'components/Button.figma.json'), JSON.stringify({fill:'color-primary',size:{width:120,height:40},text:{characters:'Save',fontSize:14}}));
    writeFileSync(join(p.root,'components/Other.tsx'), 'export function Other(){return <div/>}');
    const listed = await p.service.listComponents();
    assert.equal((listed.components as any[]).find(item => item.name === 'Other').descriptionStatus,'needs-review');
    const selected = {kind:'component' as const,key:'components/Button.tsx#Button'};
    const key = (listed.components as any[]).find(item => item.name === 'Button').codeKey;
    selected.key = key;
    const plan = await p.service.plan(selected);
    assert.deepEqual(plan.entries.map(item => item.name).sort(),['Button','color-primary']);
    assert.equal(plan.issues.some(item => item.key.includes('Other')),false);
    await assert.rejects(p.service.apply(plan.id,{enableAuto:true}),/Individual sync/);
    writeFileSync(join(p.root,'tokens.css'), ':root { --color-primary: #223344; --color-unrelated: #abcdef; }');
    await assert.rejects(p.service.apply(plan.id),/changed after review/);
    assert.equal(p.calls.some(method => method === 'upsert_variables'),false);
  } finally {p.cleanup();}
});

test('full plans read managed components but not unrelated unmanaged Figma nodes', async () => {
  const p = project(true);
  try {
    await p.service.apply((await p.service.plan()).id);
    const manifest = JSON.parse(readFileSync(join(p.root,'elf.manifest.json'),'utf8'));
    const buttonId = Object.values<any>(manifest.components)[0].figmaNodeId;
    p.refs.push({id:'unmanaged',name:'Unmanaged',codeKey:'Unmanaged.tsx#Unmanaged'});
    p.nodes.unmanaged = {id:'unmanaged',name:'Unmanaged',codeKey:'Unmanaged.tsx#Unmanaged',type:'COMPONENT',width:100,height:40,children:[]};
    p.nodeReads.length = 0;
    const plan = await p.service.plan();
    assert.deepEqual([...new Set(p.nodeReads)], [buttonId]);
    assert.equal(plan.issues.some(issue => issue.key.includes('Unmanaged')), false);
  } finally {p.cleanup();}
});

test('individual component review reads only the selected component and its dependencies', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'components/Child.tsx'),'export function Child(){return <div/>}');
    writeFileSync(join(p.root,'components/Child.figma.json'),JSON.stringify({size:{width:80,height:40}}));
    writeFileSync(join(p.root,'components/Other.tsx'),'export function Other(){return <div/>}');
    writeFileSync(join(p.root,'components/Other.figma.json'),JSON.stringify({size:{width:90,height:40}}));
    writeFileSync(join(p.root,'components/Button.tsx'),"import {Child} from './Child'; export function Button(){return <Child/>}");
    await p.service.apply((await p.service.plan()).id);
    const manifest = JSON.parse(readFileSync(join(p.root,'elf.manifest.json'),'utf8'));
    const buttonKey = Object.keys(manifest.components).find(key => key.endsWith('#Button'))!;
    const childKey = Object.keys(manifest.components).find(key => key.endsWith('#Child'))!;
    const otherKey = Object.keys(manifest.components).find(key => key.endsWith('#Other'))!;
    const buttonId = manifest.components[buttonKey].figmaNodeId;
    const childId = manifest.components[childKey].figmaNodeId;
    const otherId = manifest.components[otherKey].figmaNodeId;
    p.calls.length = 0;
    p.nodeReads.length = 0;
    const plan = await p.service.plan({kind:'component',key:buttonKey});
    assert.equal(plan.selection?.key,buttonKey);
    const reads = [...new Set(p.nodeReads)].sort();
    assert.deepEqual(reads,[buttonId,childId].sort());
    assert.equal(reads.includes(otherId),false);
    writeFileSync(join(p.root,'components/Button.figma.json'),JSON.stringify({size:{width:140,height:40},text:{characters:'Save',fontSize:14}}));
    const reviewed = await p.service.plan({kind:'component',key:buttonKey});
    assert.ok(reviewed.entries.some(entry => entry.key === buttonKey));
    writeFileSync(join(p.root,'components/Other.figma.json'),JSON.stringify({size:{width:200,height:40}}));
    await p.service.apply(reviewed.id);
    assert.equal(p.nodes[otherId].width,90);
  } finally {p.cleanup();}
});

test('automatic sync scopes watcher changes to the changed component and its dependencies', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'components/Child.tsx'),'export function Child(){return <div/>}');
    writeFileSync(join(p.root,'components/Child.figma.json'),JSON.stringify({size:{width:80,height:40}}));
    writeFileSync(join(p.root,'components/Other.tsx'),'export function Other(){return <div/>}');
    writeFileSync(join(p.root,'components/Other.figma.json'),JSON.stringify({size:{width:90,height:40}}));
    writeFileSync(join(p.root,'components/Button.tsx'),"import {Child} from './Child'; export function Button(){return <Child/>}");
    await p.service.apply((await p.service.plan()).id,{enableAuto:true});
    const manifest = JSON.parse(readFileSync(join(p.root,'elf.manifest.json'),'utf8'));
    const buttonKey = Object.keys(manifest.components).find(key => key.endsWith('#Button'))!;
    const childKey = Object.keys(manifest.components).find(key => key.endsWith('#Child'))!;
    const otherKey = Object.keys(manifest.components).find(key => key.endsWith('#Other'))!;
    const buttonId = manifest.components[buttonKey].figmaNodeId;
    const childId = manifest.components[childKey].figmaNodeId;
    const otherId = manifest.components[otherKey].figmaNodeId;
    writeFileSync(join(p.root,'components/Button.figma.json'),JSON.stringify({size:{width:140,height:40},text:{characters:'Save',fontSize:14}}));
    p.calls.length = 0; p.nodeReads.length = 0;
    const result = await p.service.autoSync([join(p.root,'components/Button.figma.json')]);
    assert.equal(result.paused,false);
    assert.ok(Number(result.synced) >= 1);
    assert.deepEqual([...new Set(p.nodeReads)].sort(),[buttonId,childId].sort());
    assert.equal(p.nodes[buttonId].width,140);
    assert.equal(p.nodes[otherId].width,90);
  } finally {p.cleanup();}
});

test('automatic sync selects every component parsed from one source file', async () => {
  const p = project(true);
  try {
    const config = {configPath:p.path,root:p.root,tokensFile:join(p.root,'tokens.css'),componentsDir:join(p.root,'components'),manifestFile:join(p.root,'elf.manifest.json'),modeStrategy:'modes',semanticModes:['Light','Dark'],chunkSize:5,collections:{primitives:'Primitives',semantic:'Semantic'}};
    const parsed = ['PrimaryButton','SecondaryButton'].map(name => ({parsed:{name,codeKey:`controls.tsx#${name}`,file:'controls.tsx',variantProps:[],dependencies:[]},sidecar:null,variants:[]}));
    const tokens = {primitives:{collection:'Primitives',modes:['Value'],variables:[]},semantic:{collection:'Semantic',modes:['Light','Dark'],variables:[]},textStyles:[],effectStyles:[]};
    const scope = (p.service as any).autoScope(config,parsed,tokens,{version:1,components:{},tokens:{}},[join(p.root,'components/controls.tsx')]);
    assert.deepEqual([...scope.ids].sort(),['component:controls.tsx#PrimaryButton','component:controls.tsx#SecondaryButton']);
  } finally {p.cleanup();}
});

test('automatic sync detects deleted components by source file rather than filename', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'components/controls.tsx'),'export function PrimaryButton(){return <button/>}');
    writeFileSync(join(p.root,'components/controls.figma.json'),JSON.stringify({text:{characters:'Controls',fontSize:14}}));
    await p.service.apply((await p.service.plan()).id,{enableAuto:true});
    const manifestPath = join(p.root,'elf.manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath,'utf8'));
    const key = Object.keys(manifest.components).find(item => item.startsWith('controls.tsx#'))!;
    manifest.components['controls.tsx#PrimaryButton'] = manifest.components[key];
    delete manifest.components[key];
    writeFileSync(manifestPath,JSON.stringify(manifest));
    rmSync(join(p.root,'components/controls.tsx'));
    p.calls.length = 0; p.nodeReads.length = 0;
    const result = await p.service.autoSync([join(p.root,'components/controls.tsx')]);
    assert.equal(result.paused,true);
    assert.ok((result.conflicts as any[]).some(issue => issue.kind === 'removed' && issue.key === 'controls.tsx#PrimaryButton'));
    assert.equal(p.calls.some(call => /^(upsert|create|delete)/.test(call)),false);
    assert.equal(p.nodeReads.length,0);
  } finally {p.cleanup();}
});

test('automatic sync pauses when a managed component is deleted from code', async () => {
  const p = project(true);
  try {
    await p.service.apply((await p.service.plan()).id,{enableAuto:true});
    const manifest = JSON.parse(readFileSync(join(p.root,'elf.manifest.json'),'utf8'));
    const buttonKey = Object.keys(manifest.components).find(key => key.endsWith('#Button'))!;
    const buttonId = manifest.components[buttonKey].figmaNodeId;
    rmSync(join(p.root,'components/Button.tsx'));
    p.calls.length = 0; p.nodeReads.length = 0;
    const result = await p.service.autoSync([join(p.root,'components/Button.tsx')]);
    assert.equal(result.paused,true);
    assert.ok((result.conflicts as any[]).some(issue => issue.kind === 'removed' && issue.key === buttonKey));
    assert.equal(p.calls.some(call => /^(upsert|create|delete)/.test(call)),false);
    assert.equal(p.nodeReads.length,0);
    assert.ok(p.refs.some(ref => ref.id === buttonId));
  } finally {p.cleanup();}
});

test('automatic sync scopes token changes without reading components', async () => {
  const p = project(true);
  try {
    await p.service.apply((await p.service.plan()).id,{enableAuto:true});
    writeFileSync(join(p.root,'tokens.css'), ':root { --color-primary: #112233; --spacing-2: 8px; }');
    p.calls.length = 0; p.nodeReads.length = 0;
    const result = await p.service.autoSync([join(p.root,'tokens.css')]);
    assert.equal(result.paused,false);
    assert.equal(p.calls.includes('list_components'),false);
    assert.equal(p.nodeReads.length,0);
    assert.ok(p.variables.some(item => item.codeKey === 'spacing-2'));
    assert.equal(p.variables.find(item => item.codeKey === 'color-primary').valuesByMode.Value.value,'#112233');
  } finally {p.cleanup();}
});

test('individual reviews reject selected remote and connection changes but ignore unrelated remote edits', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'components/Child.tsx'),'export function Child(){return <div/>}');
    writeFileSync(join(p.root,'components/Child.figma.json'),JSON.stringify({size:{width:80,height:40}}));
    writeFileSync(join(p.root,'components/Other.tsx'),'export function Other(){return <div/>}');
    writeFileSync(join(p.root,'components/Other.figma.json'),JSON.stringify({size:{width:90,height:40}}));
    writeFileSync(join(p.root,'components/Button.tsx'),"import {Child} from './Child'; export function Button(){return <Child/>}");
    await p.service.apply((await p.service.plan()).id);
    const manifest = JSON.parse(readFileSync(join(p.root,'elf.manifest.json'),'utf8'));
    const buttonKey = Object.keys(manifest.components).find(key => key.endsWith('#Button'))!;
    const otherKey = Object.keys(manifest.components).find(key => key.endsWith('#Other'))!;
    const buttonId = manifest.components[buttonKey].figmaNodeId;
    const otherId = manifest.components[otherKey].figmaNodeId;
    writeFileSync(join(p.root,'components/Button.figma.json'),JSON.stringify({size:{width:140,height:40},text:{characters:'Save',fontSize:14}}));
    const reviewed = await p.service.plan({kind:'component',key:buttonKey});
    p.nodes[otherId].width = 200;
    await p.service.apply(reviewed.id);
    assert.equal(p.nodes[buttonId].width,140);
    assert.equal(p.nodes[otherId].width,200);
    writeFileSync(join(p.root,'components/Button.figma.json'),JSON.stringify({size:{width:150,height:40},text:{characters:'Save',fontSize:14}}));
    const remoteReview = await p.service.plan({kind:'component',key:buttonKey});
    p.nodes[buttonId].width = 160;
    await assert.rejects(p.service.apply(remoteReview.id),/changed after review/);
    assert.equal(p.nodes[buttonId].width,160);
    writeFileSync(join(p.root,'components/Button.figma.json'),JSON.stringify({size:{width:170,height:40},text:{characters:'Save',fontSize:14}}));
    const connectionReview = await p.service.plan({kind:'component',key:buttonKey});
    (p.runtime.connection.status as any).connectedAt = new Date(Date.now() + 1000).toISOString();
    await assert.rejects(p.service.apply(connectionReview.id),/changed after review/);
  } finally {p.cleanup();}
});

test('individual token apply does not write unselected tokens or components', async () => {
  const p = project(true);
  try {
    writeFileSync(join(p.root,'tokens.css'), ':root { --color-primary: #112233; --color-unrelated: #abcdef; }');
    const plan = await p.service.plan({kind:'token',key:'color-primary'});
    assert.equal(plan.entries.length,1);
    assert.equal(p.nodeReads.length,0);
    await p.service.apply(plan.id);
    assert.deepEqual(p.variables.map(item => item.codeKey),['color-primary']);
    assert.equal(p.calls.includes('upsert_component'),false);
  } finally {p.cleanup();}
});


test('token import creates only an explicitly reviewed new file and rejects changed Figma and existing outputs', async () => {
  const p=project();
  try {
    p.collections.push({id:'c',name:'Colors',defaultModeId:'light',modes:[{modeId:'light',name:'Light'},{modeId:'dark',name:'Dark'}]});
    p.variables.push({id:'new',name:'color/new',collectionId:'c',resolvedType:'COLOR',valuesByMode:{Light:{type:'COLOR',value:'#ffffff'},Dark:{type:'COLOR',value:'#111111'}}});
    const plan=await p.service.planTokenImport();
    assert.equal(plan.format,'Elf JSON');
    assert.deepEqual(plan.names,['color-new']);
    assert.throws(() => readFileSync(join(p.root,'figma.tokens.json')));
    assert.equal(p.calls.some(method => /create|upsert/.test(method)),false);
    p.variables[0].valuesByMode.Dark.value='#222222';
    await assert.rejects(p.service.applyTokenImport(plan.id as string),/changed/);
    const fresh=await p.service.planTokenImport();
    writeFileSync(join(p.root,'figma.tokens.json'),'user content');
    await assert.rejects(p.service.applyTokenImport(fresh.id as string),/changed|exists/);
    assert.equal(readFileSync(join(p.root,'figma.tokens.json'),'utf8'),'user content');
    await assert.rejects(p.service.planTokenImport('reviewed.tokens.json'),/JSON|Unexpected/);
  } finally {p.cleanup();}
});

test('token import applies once without writing Figma and preserves complete modes', async () => {
  const p=project();
  try {
    p.collections.push({id:'c',name:'Colors',defaultModeId:'light',modes:[{modeId:'light',name:'Light'},{modeId:'dark',name:'Dark'}]});
    p.variables.push({id:'new',name:'color/new',collectionId:'c',resolvedType:'COLOR',valuesByMode:{Light:{type:'COLOR',value:'#ffffff'},Dark:{type:'COLOR',value:'#111111'}}});
    const plan=await p.service.planTokenImport();
    const result=await p.service.applyTokenImport(plan.id as string);
    assert.equal(result.imported,1);
    const data=JSON.parse(readFileSync(join(p.root,'figma.tokens.json'),'utf8'));
    assert.equal(data.tokens['color-new'].modes.Dark,'#111111');
    assert.equal(data.source.variables[0].id,'new');
    const {loadConfig}=await import('../src/config.js');
    const {parseProjectTokens}=await import('../src/codebase/index.js');
    const discovered=loadConfig(p.path);
    assert(discovered.codebase.paths?.includes(join(p.root,'figma.tokens.json')));
    const code=await parseProjectTokens(discovered.codebase);
    assert(code.some(item=>item.name==='color-new' && item.mode==='Dark' && item.value==='#111111'));
    await assert.rejects(p.service.applyTokenImport(plan.id as string),/expired/);
    assert.equal(p.calls.some(method => /create|upsert/.test(method)),false);
    await assert.rejects(p.service.planTokenImport('../outside.tokens.json'),/filename/);
    await assert.rejects(p.service.planTokenImport(),/already exists/);
  } finally {p.cleanup();}
});


test('individual sync cannot override an invalid required component dependency',async()=>{
 const p=project(true);
 try {
  writeFileSync(join(p.root,'components/Child.tsx'),'export function Child(){return <div/>}');
  writeFileSync(join(p.root,'components/Button.tsx'),"import {Child} from './Child'; export function Button(){return <Child/>}");
  const listed=await p.service.listComponents();const key=(listed.components as any[]).find(item=>item.name==='Button').codeKey;
  await assert.rejects(p.service.plan({kind:'component',key}),/required dependency/);
  assert.equal(p.calls.some(method=>/upsert|create/.test(method)),false);
 } finally {p.cleanup();}
});


test('component import prepares context, validates reviewed code and exclusively creates one local file',async()=>{
 const p=project(true);try{
  p.refs.push({id:'remote-component',name:'Figma Alert'});p.nodes['remote-component']={id:'remote-component',name:'Figma Alert',type:'COMPONENT',width:180,height:40,children:[]};
  const options={nodeId:'remote-component',framework:'react' as const,library:'native',path:'ImportedAlert.tsx',reuse:[]};
  const catalog=await p.service.listComponentImports();assert.equal((catalog.components as any[])[0].name,'Figma Alert');
  const context=await p.service.prepareComponentImport(options);
  const code='export function ImportedAlert(){return <section aria-label="Notice">Hello</section>}';
  assert.equal((await p.service.validateComponentImport(context.id as string,code)).valid,true);
  assert.throws(()=>readFileSync(join(p.root,options.path)));
  await p.service.applyComponentImport(context.id as string,code);
  assert.match(readFileSync(join(p.root,options.path),'utf8'),/ImportedAlert/);
  assert.equal(p.calls.some(method=>/upsert|create/.test(method)),false);
  await assert.rejects(p.service.applyComponentImport(context.id as string,code),/expired/);
  await assert.rejects(p.service.prepareComponentImport(options),/exists/);
  await assert.rejects(p.service.prepareComponentImport({...options,path:'Other.tsx',library:'not-installed'}),/library/);
  await assert.rejects(p.service.prepareComponentImport({...options,path:'../Outside.tsx'}),/source folder|inside/);
 }finally{p.cleanup();}
});
test('component import refuses changed source or Figma and unsafe code without creating output',async()=>{
 const p=project(true);try{
  p.refs.push({id:'remote',name:'Remote'});p.nodes.remote={id:'remote',type:'COMPONENT',width:80,height:1,children:[]};
  const options={nodeId:'remote',framework:'react' as const,library:'native',path:'ImportedDivider.tsx',reuse:[]};
  const context=await p.service.prepareComponentImport(options);
  await assert.rejects(p.service.validateComponentImport(context.id as string,"import fs from 'node:fs';export function ImportedDivider(){return <div/>}"),/confirmed/);
  p.nodes.remote.width=100;
  await assert.rejects(p.service.applyComponentImport(context.id as string,'export function ImportedDivider(){return <hr/>}'),/changed/);
  assert.throws(()=>readFileSync(join(p.root,options.path)));
 }finally{p.cleanup();}
});
test('reviewed replacement restores an edited Figma token even when the code value has not changed',async()=>{
 const p=project();try{
  await p.service.apply((await p.service.plan()).id);
  p.variables[0].valuesByMode.Value.value='#abcdef';
  const plan=await p.service.plan({kind:'token',key:'color-primary'});
  await assert.rejects(p.service.apply(plan.id),/Figma has edits/);
  await p.service.apply(plan.id,{overwriteConflicts:true});
  assert.equal(p.variables[0].valuesByMode.Value.value,'#112233');
 }finally{p.cleanup();}
});

test('library setup uses fixed recipes, respects the package manager and remembers only declared selections',async()=>{
 const p=project();try{
  const setup=await p.service.componentLibrarySetup('@mui/material');
  assert.equal(setup.command,'npm install --ignore-scripts @mui/material @emotion/react @emotion/styled');
  assert.equal(setup.requiresReact,true);
  await assert.rejects(p.service.componentLibrarySetup('x; touch /tmp/unsafe'),/supported/);
  await assert.rejects(p.service.rememberComponentLibrary('@mui/material'),/Install/);
  writeFileSync(join(p.root,'pnpm-lock.yaml'),'lockfileVersion: 9');
  assert.match(String((await p.service.componentLibrarySetup('@mantine/core')).command),/^pnpm add --ignore-scripts/);
  writeFileSync(join(p.root,'package.json'),JSON.stringify({dependencies:{react:'^19', 'react-dom':'^19','@mui/material':'^7'}}));
  assert.equal((await p.service.componentLibrarySetup('@mui/material')).command,null);
  await p.service.rememberComponentLibrary('@mui/material');
  assert.equal(JSON.parse(readFileSync(p.path,'utf8')).runtime.componentLibrary,'@mui/material');
  assert.equal((await p.service.listComponentImports()).preferredLibrary,'@mui/material');
 }finally{p.cleanup();}
});

test('CSS separator aliases validate and save reviewed component descriptions',async()=>{
 const p=project(true);try{
  writeFileSync(join(p.root,'tokens.css'),':root { --spacing-2: 8px; --color-primary: #112233; }');
  const draft=await p.service.prepareComponent('Button');
  const description={layoutMode:'HORIZONTAL',gap:'spacing.2',fill:'color.primary',size:{width:120,height:40}};
  await p.service.validateDescription('Button',description,String(draft.reviewHash));
  await p.service.saveDescription('Button',description,String(draft.reviewHash));
  assert.equal((await p.service.prepareComponent('Button')).warning,null);
 }finally{p.cleanup();}
});

test('description uploads preserve unresolved and wrong-type tokens while blocking unsafe sync',async()=>{
 const p=project(true);try{
  const prepared=await p.service.prepareComponent('Button');
  const description={gap:'color-primary',fill:'missing.color'};
  const valid=await p.service.validateDescription('Button',description,String(prepared.reviewHash));
  assert.equal(valid.valid,true);assert.equal(valid.syncReady,false);assert.equal((valid.warnings as string[]).length,2);
  await assert.rejects(p.service.validateDescription('Button',{gap:'missing',size:'invalid'},String(prepared.reviewHash)),/size/);
  await assert.rejects(p.service.saveDescription('Button',{unknown:1},String(prepared.reviewHash)),/unknown field/);
  await p.service.saveDescription('Button',description,String(prepared.reviewHash));
  assert.deepEqual(JSON.parse(readFileSync(join(p.root,'components','Button.figma.json'),'utf8')),description);
  const plan=await p.service.plan();
  assert.equal(plan.entries.some(entry=>entry.kind==='component'),false);
  assert.equal(p.calls.some(method=>/^(upsert|create|delete)/.test(method)),false);
 }finally{p.cleanup();}
});

test('local description uploads do not require a connected Figma plugin',async()=>{
 const p=project(true);try{
  const offline=new ProjectService(p.path,{transaction:async()=>{throw new Error('Plugin offline');}} as unknown as BridgeRuntime);
  const prepared=await offline.prepareComponent('Button');
  const result=await offline.saveDescription('Button',{gap:'unresolved.spacing'},String(prepared.reviewHash));
  assert.equal(result.saved,true);assert.equal(result.syncReady,false);
 }finally{p.cleanup();}
});

test('shadcn setup uses an explicit CLI recipe and requires selected local components',async()=>{
 const p=project(true);try{
  const setup=await p.service.componentLibrarySetup('shadcn');
  assert.equal(setup.command,'npx shadcn@latest init');assert.equal(setup.executesSetup,true);
  await assert.rejects(p.service.rememberComponentLibrary('shadcn'),/setup/);
  writeFileSync(join(p.root,'package.json'),JSON.stringify({packageManager:'pnpm@10.0.0'}));
  assert.equal((await p.service.componentLibrarySetup('shadcn')).command,'pnpm dlx shadcn@latest init');
  writeFileSync(join(p.root,'package.json'),JSON.stringify({packageManager:'bun@1.0.0'}));
  assert.equal((await p.service.componentLibrarySetup('shadcn')).command,'bunx --bun shadcn@latest init');
  writeFileSync(join(p.root,'package.json'),JSON.stringify({packageManager:'unsafe;command@1'}));
  assert.equal((await p.service.componentLibrarySetup('shadcn')).command,'npx shadcn@latest init');
  writeFileSync(join(p.root,'components.json'),JSON.stringify({style:'default',aliases:{ui:'@/components/ui'}}));
  const configured=await p.service.componentLibrarySetup('shadcn');assert.equal(configured.installed,true);
  p.refs.push({id:'remote',name:'Notice'});p.nodes.remote={id:'remote',type:'COMPONENT',children:[]};
  const options={nodeId:'remote',framework:'react' as const,library:'shadcn',path:'ImportedNotice.tsx',reuse:[] as string[]};
  await assert.rejects(p.service.prepareComponentImport(options),/local shadcn/);
  const local=(await p.service.listComponentImports()).reusable as any[];
  const context=await p.service.prepareComponentImport({...options,reuse:[local[0].codeKey]});
  assert.equal((context.libraryGuide as any).label,'shadcn/ui');
  writeFileSync(join(p.root,'components.json'),JSON.stringify({style:'changed',aliases:{ui:'@/components/ui'}}));
  await assert.rejects(p.service.applyComponentImport(String(context.id),"export function ImportedNotice(){return <div/>}"),/changed/);
  await p.service.rememberComponentLibrary('shadcn');
  assert.equal((await p.service.listComponentImports()).preferredLibrary,'shadcn');
 }finally{p.cleanup();}
});

test('HeroUI v3 requires v3 packages plus React 19 and Tailwind 4 without upgrading automatically',async()=>{
 const p=project();try{
  let setup=await p.service.componentLibrarySetup('@heroui/react');
  assert.equal(setup.command,'npm install --ignore-scripts @heroui/react@^3 @heroui/styles@^3');
  assert.equal((setup.prerequisites as string[]).length,2);
  writeFileSync(join(p.root,'package.json'),JSON.stringify({dependencies:{react:'^18.3.0','react-dom':'^18.3.0',tailwindcss:'^3.4.0','@heroui/react':'^2.8.0'}}));
  setup=await p.service.componentLibrarySetup('@heroui/react');assert.equal(setup.installed,false);
  await assert.rejects(p.service.rememberComponentLibrary('@heroui/react'),/19/);
  writeFileSync(join(p.root,'package.json'),JSON.stringify({dependencies:{react:'^19.0.0','react-dom':'^19.0.0',tailwindcss:'^4.0.0','@heroui/react':'^3.2.6','@heroui/styles':'^3.2.6'}}));
  setup=await p.service.componentLibrarySetup('@heroui/react');assert.equal(setup.installed,true);assert.deepEqual(setup.prerequisites,[]);
  await p.service.rememberComponentLibrary('@heroui/react');
  assert.equal((await p.service.listComponentImports()).preferredLibrary,'@heroui/react');
 }finally{p.cleanup();}
});

test('automatic sync skips a conflicted token and dependent component while syncing independent resources',async()=>{
 const p=project(true);try{
  await p.service.apply((await p.service.plan()).id,{enableAuto:true});
  const button=p.refs.find(item=>item.name==='Button');const beforeNode=JSON.stringify(p.nodes[button.id]);
  p.variables[0].valuesByMode.Value.value='#abcdef';
  writeFileSync(join(p.root,'tokens.css'),':root { --color-primary: #445566; --spacing-2: 8px; }');
  writeFileSync(join(p.root,'components','Button.figma.json'),JSON.stringify({fill:'color.primary',size:{width:180,height:40}}));
  writeFileSync(join(p.root,'components','Independent.tsx'),'export function Independent(){return <div/>}');
  writeFileSync(join(p.root,'components','Independent.figma.json'),JSON.stringify({size:{width:80,height:40}}));
  const result=await p.service.autoSync();
  assert.equal(result.paused,false);assert.equal(p.service.automatic(),true);
  assert.equal(p.variables.find(item=>item.codeKey==='color-primary').valuesByMode.Value.value,'#abcdef');
  assert(p.variables.some(item=>item.codeKey==='spacing-2'));
  assert(p.refs.some(item=>item.name==='Independent'));
  assert.equal(JSON.stringify(p.nodes[button.id]),beforeNode);
 }finally{p.cleanup();}
});

test('enabling automatic sync with conflicts applies safe entries without replacing Figma edits',async()=>{
 const p=project();try{
  await p.service.apply((await p.service.plan()).id);
  p.variables[0].valuesByMode.Value.value='#abcdef';
  writeFileSync(join(p.root,'tokens.css'),':root { --color-primary: #445566; --spacing-2: 8px; }');
  const result=await p.service.apply((await p.service.plan()).id,{enableAuto:true,overwriteConflicts:true});
  assert.equal(p.service.automatic(),true);assert.equal(result.synced,1);
  assert.equal(p.variables.find(item=>item.codeKey==='color-primary').valuesByMode.Value.value,'#abcdef');
  assert(p.variables.some(item=>item.codeKey==='spacing-2'));
 }finally{p.cleanup();}
});

test('intentional differences hold only the selected token and leave independent automatic changes running',async()=>{
 const p=project();try{
  await p.service.apply((await p.service.plan()).id,{enableAuto:true});
  const raw=JSON.parse(readFileSync(p.path,'utf8'));raw.intentionalDifferences=[{name:'color-primary',figmaValue:'#112233',codeValue:'#334455',reason:'Platform contrast'}];writeFileSync(p.path,JSON.stringify(raw));
  writeFileSync(join(p.root,'tokens.css'),':root { --color-primary: #334455; --spacing-2: 8px; }');
  const result=await p.service.autoSync();
  assert.equal(result.paused,false);assert.equal(p.variables[0].valuesByMode.Value.value,'#112233');
  assert(p.variables.some(item=>item.codeKey==='spacing-2'));
 }finally{p.cleanup();}
});

test('reviewed description saves remain eligible for the next automatic sync pass',async()=>{
 const p=project(true);try{
  await p.service.apply((await p.service.plan()).id,{enableAuto:true});
  const prepared=await p.service.prepareComponent('Button');
  await p.service.saveDescription('Button',{size:{width:180,height:40}},String(prepared.reviewHash));
  assert.equal(p.service.automatic(),true);
  await p.service.autoSync();
  const button=p.refs.find(item=>item.name==='Button');
  assert.equal(p.nodes[button.id].width,180);
 }finally{p.cleanup();}
});

test('prose documentation sync updates only the Description field without resolving visual tokens',async()=>{
 const p=project(true);try{
  p.refs.push({id:'doc-node',name:'Button',codeKey:'Button.tsx#Button'});p.nodes['doc-node']={id:'doc-node',name:'Button',type:'COMPONENT',codeKey:'Button.tsx#Button',description:'Old prose',width:120,height:40,children:[]};
  writeFileSync(join(p.root,'components','Button.figma.json'),JSON.stringify({gap:'missing.token'}));
  const before={...p.nodes['doc-node']};const sidecar=readFileSync(join(p.root,'components','Button.figma.json'),'utf8');
  const prepared=await p.service.prepareDocumentation('Button');
  const text='Immediate action. Use a clear label describing the result.';
  await p.service.saveDocumentation(String(prepared.id),text);
  await p.service.syncDocumentation(String(prepared.id),text);
  assert.deepEqual(p.nodes['doc-node'],{...before,description:text});
  assert.equal(readFileSync(join(p.root,'components','Button.figma.json'),'utf8'),sidecar);
  assert.equal(p.calls.some(method=>/upsert|create/.test(method)),false);
  await assert.rejects(p.service.syncDocumentation(String(prepared.id),text),/fresh/);
 }finally{p.cleanup();}
});

test('documentation sync rejects remote edits, source changes and a changed file',async()=>{
 const p=project(true);try{
  p.refs.push({id:'doc-node',name:'Button',codeKey:'Button.tsx#Button'});p.nodes['doc-node']={id:'doc-node',name:'Button',type:'COMPONENT',codeKey:'Button.tsx#Button',description:'Original'};
  let prepared=await p.service.prepareDocumentation('Button');
  await p.service.saveDocumentation(String(prepared.id),'Reviewed prose');p.nodes['doc-node'].description='A designer edited this';
  await assert.rejects(p.service.syncDocumentation(String(prepared.id),'Reviewed prose'),/changed/);
  assert.equal(p.nodes['doc-node'].description,'A designer edited this');
  prepared=await p.service.prepareDocumentation('Button');
  writeFileSync(join(p.root,'components','Button.tsx'),'export function Button(){return <button>Different</button>}');
  await assert.rejects(p.service.saveDocumentation(String(prepared.id),'Reviewed prose'),/source/);
  prepared=await p.service.prepareDocumentation('Button');
  const raw=JSON.parse(readFileSync(p.path,'utf8'));raw.figma.fileKey='another-file';writeFileSync(p.path,JSON.stringify(raw));
  await assert.rejects(p.service.saveDocumentation(String(prepared.id),'Reviewed prose'),/Figma file changed/);
 }finally{p.cleanup();}
});
