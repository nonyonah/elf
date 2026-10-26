import { verifyComponentPatch, verifyStylePatch } from "./verify-write.js";
import { cssColorToHex } from "./core/normalize.js";
import { readActivity, recordActivity, type Activity } from "./activity.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runElfCheck } from "../watch/src/check.js";
import { loadConfig } from "./config.js";
import { projectResource, writeProjectConfig } from "./onboarding.js";
import { parseCodebaseTokens } from "./codebase/index.js";
import { hashSpec, loadManifest, saveManifest, stableStringify } from "../batch/src/manifest.js";
import { planTokens, type TokenIndex } from "../batch/src/tokens.js";
import { componentSourceHash, componentSpecHash, planComponent, processComponent, syncTokens } from "../batch/src/sync.js";
import { parseComponents } from "../batch/src/parser.js";
import { loadSidecar, resolveSidecar, sidecarPathFor, validateSidecar } from "../batch/src/sidecar.js";
import { orderComponents } from "../batch/src/graph.js";
import { NODE_STATE_DEPTH, nodeStateHash } from "../batch/src/nodestate.js";
import type { BatchConfig, BridgeCaller, Manifest, PlannedComponent, TokensPlan } from "../batch/src/types.js";
import type { BridgeRuntime } from "../mcp/src/runtime.js";

export interface PlanEntry { kind: "token" | "component" | "style"; key: string; name: string; action: "create" | "update"; }
export interface PlanIssue { kind: "conflict" | "unsupported" | "removed"; key: string; message: string; }
export interface SyncPlan { id: string; fileKey: string; entries: PlanEntry[]; issues: PlanIssue[]; expiresAt: string; }
interface Snapshot { collections: any[]; variables: any[]; components: any[]; nodes: Record<string, unknown>; styles: any[]; }
interface InternalPlan { view: SyncPlan; fingerprint: string; config: BatchConfig; manifest: Manifest; tokens: TokensPlan; components: PlannedComponent[]; snapshot: Snapshot; }
const writes = (plan: SyncPlan, kind: PlanEntry["kind"]): Set<string> => new Set(plan.entries.filter(entry => entry.kind === kind).map(entry => entry.key));

/** The same managed workflow is used by Settings, automatic watch, CLI and MCP. */
export class ProjectService {
  get activity(): Activity[] { return readActivity(this.configPath); }
  private reviewed = new Map<string, InternalPlan>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly configPath: string, private readonly runtime: BridgeRuntime) { this.migrate(); }

  record(type: Activity["type"], message: string): void {
    recordActivity(this.configPath, type, message);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work); this.tail = next.catch(() => {}); return next;
  }
  private raw(): any { return JSON.parse(readFileSync(this.configPath, "utf8")); }
  private migrate(): void {
    if (!existsSync(this.configPath)) return;
    const raw = this.raw();
    const legacyPath = join(dirname(this.configPath), "elf-batch.config.json");
    if (raw.sync || !existsSync(legacyPath)) return;
    const old = JSON.parse(readFileSync(legacyPath, "utf8"));
    if (!old.tokens) return;
    const root = realpathSync(dirname(resolve(this.configPath)));
    const tokens = relative(root, this.resource(root, old.tokens));
    const components = old.components ? relative(root, this.resource(root, old.components, true)) || "." : undefined;
    const manifest = relative(root, this.outputPath(old.manifest ?? "elf.manifest.json"));
    writeProjectConfig(this.configPath, { ...raw, sync: { ...old, tokens, components, manifest }, ...(raw.components || !components ? {} : { components: { path: components, manifest } }) });
  }
  automatic(): boolean { try { return this.raw().runtime?.autoSync === true; } catch { return false; } }
  setMonitoring(): void {
    const raw = this.raw(); writeProjectConfig(this.configPath, { ...raw, runtime: { ...raw.runtime, autoSync: false } });
    this.record("sync", "Automatic sync paused. Monitoring continues.");
  }
  async check(): Promise<Record<string, unknown>> {
    return this.serial(async () => {
      const config = loadConfig(this.configPath);
      if (this.runtime.connection.status.file?.key !== config.figma.fileKey) throw new Error("Connect this project's configured Figma file first.");
      const result = await runElfCheck(this.configPath, dirname(this.configPath), false);
      this.record(result.status === "failed" ? "error" : "check", result.status === "clean" ? "No drift found." : result.status === "drift" ? `${result.total ?? "Some"} drift items remain.` : result.message ?? "Check failed.");
      return { ...result, report: join(dirname(this.configPath), "drift-report.md") };
    });
  }
  async plan(): Promise<SyncPlan> {
    return this.serial(() => this.runtime.transaction(loadConfig(this.configPath).figma.fileKey, async client => {
      const plan = await this.build(client);
      for (const [id, previous] of this.reviewed) if (Date.parse(previous.view.expiresAt) < Date.now()) this.reviewed.delete(id);
      if (this.reviewed.size >= 20) this.reviewed.delete(this.reviewed.keys().next().value!);
      this.reviewed.set(plan.view.id, plan);
      return plan.view;
    }));
  }
  async apply(id: string, options: { enableAuto?: boolean; overwriteConflicts?: boolean } = {}): Promise<Record<string, unknown>> {
    return this.serial(() => this.runtime.transaction(loadConfig(this.configPath).figma.fileKey, async client => {
      const reviewed = this.reviewed.get(id);
      if (!reviewed || Date.parse(reviewed.view.expiresAt) < Date.now()) throw new Error("This sync plan expired. Review a fresh plan.");
      const fresh = await this.build(client);
      if (fresh.fingerprint !== reviewed.fingerprint) throw new Error("Code, configuration, or Figma changed after review. Review a fresh plan before applying.");
      if (fresh.view.issues.some(issue => issue.kind === "conflict") && !options.overwriteConflicts) throw new Error("Figma has edits. Keep them, or explicitly choose to replace the conflicts in this reviewed plan.");
      if (options.enableAuto && fresh.view.issues.some(issue => issue.kind !== "unsupported")) throw new Error("Resolve conflicts and removed resources before enabling automatic sync.");
      this.reviewed.delete(id);
      const result = await this.execute(fresh, client);
      if (options.enableAuto) {
        const raw = this.raw(); writeProjectConfig(this.configPath, { ...raw, runtime: { ...raw.runtime, autoSync: true } });
      }
      return result;
    }));
  }
  async autoSync(): Promise<Record<string, unknown>> {
    return this.serial(() => this.runtime.transaction(loadConfig(this.configPath).figma.fileKey, async client => {
      if (!this.automatic()) return { synced: 0, paused: false, issues: [] };
      const plan = await this.build(client);
      if (!this.automatic()) return { synced: 0, paused: false, issues: [] };
      if (plan.view.issues.some(issue => issue.kind === "conflict" || issue.kind === "removed")) {
        this.record("conflict", "Sync paused: Figma edits or removed resources need review.");
        return { synced: 0, conflicts: plan.view.issues, paused: true };
      }
      return this.execute(plan, client);
    }));
  }
  generatedPaths(): string[] { const { config } = this.batchConfig(); return [config.manifestFile, realpathSync(this.configPath), join(config.root, "drift-report.md"), join(config.root, "drift-status.json")]; }
  watchPaths(): string[] {
    const { config, hasComponents } = this.batchConfig();
    const drift = loadConfig(this.configPath);
    return [...new Set([this.resource(config.root, drift.codebase.path), config.tokensFile, ...(hasComponents ? [config.componentsDir] : [])])];
  }
  private batchConfig(): { config: BatchConfig; hasComponents: boolean; structured: boolean } {
    this.migrate();
    const raw = this.raw(); const drift = loadConfig(this.configPath); const root = realpathSync(dirname(resolve(this.configPath)));
    const sync = raw.sync ?? {};
    const tokenPath = sync.tokens ?? drift.codebase.path;
    const components = sync.components ?? raw.components?.path;
    const manifest = sync.manifest ?? raw.components?.manifest ?? "elf.manifest.json";
    const config: BatchConfig = {
      configPath: this.configPath, root, tokensFile: this.resource(root, tokenPath),
      componentsDir: components ? this.resource(root, components, true) : root,
      manifestFile: this.outputPath(manifest), modeStrategy: sync.modeStrategy ?? drift.modeStrategy,
      semanticModes: sync.semanticModes ?? ["Light", "Dark"], chunkSize: sync.chunkSize ?? 5,
      collections: { primitives: sync.collections?.primitives ?? "Primitives", semantic: sync.collections?.semantic ?? "Semantic" },
    };
    if (!["modes", "collections"].includes(config.modeStrategy) || !Array.isArray(config.semanticModes) || !config.semanticModes.length || config.semanticModes.some(mode => typeof mode !== "string" || !mode.trim())) throw new Error("Invalid sync modes in project configuration.");
    return { config, hasComponents: Boolean(components), structured: Boolean(sync.tokens) };
  }
  private resource(root: string, path: string, directory = false): string {
    return projectResource(root, typeof path === "string" && isAbsolute(path) ? relative(root, realpathSync(path)) || "." : path, directory);
  }
  private outputPath(path: unknown): string {
    const root = realpathSync(dirname(resolve(this.configPath)));
    if (typeof path !== "string" || !path || path.includes("\0")) throw new Error("Output paths must be relative to this project.");
    const requested = resolve(root, path);
    const target = join(realpathSync(dirname(requested)), basename(requested)); const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Output paths must stay inside the project.");
    projectResource(root, relative(root, dirname(target)) || ".", true);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error("Output must be a regular file, not a link.");
    return target;
  }
  private async tokens(config: BatchConfig, structured: boolean): Promise<{ plan: TokensPlan; index: TokenIndex; unsupported: PlanIssue[] }> {
    if (structured) return { ...planTokens(config.tokensFile, config), unsupported: [] };
    // Preserve rich token aliases/modes when the source already uses the batch format.
    if (config.tokensFile.endsWith(".json")) {
      try { const planned = planTokens(config.tokensFile, config); if (planned.index.size) return { ...planned, unsupported: [] }; } catch {}
    }
    const drift = loadConfig(this.configPath);
    const source = await parseCodebaseTokens(drift.codebase.source, config.tokensFile);
    const variables: TokensPlan["primitives"]["variables"] = []; const index: TokenIndex = new Map(); const unsupported: PlanIssue[] = [];
    for (const token of source) {
      const number = Number(token.value.replace(/px$/, ""));
      const type = token.category === "color" ? "COLOR" : ["spacing", "radius"].includes(token.category) && Number.isFinite(number) ? "FLOAT" : null;
      if (!type) { unsupported.push({ kind: "unsupported", key: token.name, message: `${token.name}: this token type needs an explicit sync description. It will not be written automatically.` }); continue; }
      const value = type === "COLOR" ? token.value : number;
      variables.push({ codeKey: token.name, name: token.name, type, values: { Value: value } });
      index.set(token.name, { codeKey: token.name, name: token.name, type, literal: value });
    }
    return { plan: { primitives: { collection: config.collections.primitives, modes: ["Value"], variables }, semantic: { collection: config.collections.semantic, modes: config.semanticModes, variables: [] }, textStyles: [], effectStyles: [] }, index, unsupported };
  }
  private async snapshot(client: BridgeCaller, components: PlannedComponent[], styles: boolean, scanComponents = components.length > 0): Promise<Snapshot> {
    const collections = await client.call<{ collections: any[] }>("list_collections");
    const variables = await client.call<{ variables: any[] }>("list_variables");
    const refs = scanComponents ? await client.call<{ components: any[] }>("list_components", { deep: true }) : { components: [] };
    const nodes: Record<string, unknown> = {};
    for (const ref of refs.components) {
      const { node } = await client.call<{ node: unknown }>("get_node", { nodeId: ref.id, depth: NODE_STATE_DEPTH }); nodes[ref.id] = node;
    }
    const styleList = styles ? await client.call<{ styles: any[] }>("list_styles") : { styles: [] };
    return { collections: collections.collections, variables: variables.variables, components: refs.components, nodes, styles: styleList.styles };
  }
  private async build(client: BridgeCaller): Promise<InternalPlan> {
    const { config, hasComponents, structured } = this.batchConfig();
    const tokens = await this.tokens(config, structured);
    const parsed = hasComponents ? orderComponents(parseComponents(config.componentsDir)) : [];
    const components = parsed.map(component => planComponent(config, tokens.index, component));
    const manifest = loadManifest(config.manifestFile);
    const snapshot = await this.snapshot(client, components, tokens.plan.textStyles.length + tokens.plan.effectStyles.length > 0, hasComponents || Object.keys(manifest.components).length > 0);
    const entries: PlanEntry[] = []; const issues = [...tokens.unsupported];
    const sections = [tokens.plan.primitives, ...(tokens.plan.semanticCollections ?? [tokens.plan.semantic])];
    const tokenKeys = new Set<string>();
    for (const section of sections) for (const variable of section.variables) {
      tokenKeys.add(variable.codeKey);
      const known = manifest.tokens[variable.codeKey];
      const remote = snapshot.variables.find(item => item.codeKey === variable.codeKey || (item.collectionName === section.collection && item.name === variable.name));
      if (remote?.codeKey && remote.codeKey !== variable.codeKey) { issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: this name is already owned by another code token.` }); continue; }
      if (remote && (!known || !known.remoteHash)) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: an existing Figma variable has no managed baseline. Review before taking ownership.` });
      if (known && !remote) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: deleted in Figma. Review before recreating it.` });
      if (known?.remoteHash && remote && known.remoteHash !== hashSpec(remote)) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: Figma changed since the last managed sync.` });
      if (!known || known.valueHash !== hashSpec(variable) || !remote || issues.some(issue => issue.kind === "conflict" && issue.key === variable.codeKey)) entries.push({ kind: "token", key: variable.codeKey, name: variable.name, action: remote ? "update" : "create" });
    }
    for (const component of components) {
      const known = manifest.components[component.parsed.codeKey];
      const remote = snapshot.components.find(item => item.codeKey === component.parsed.codeKey || item.id === known?.figmaNodeId || item.name === component.parsed.name);
      const key = component.parsed.codeKey;
      const specHash = componentSpecHash(config.componentsDir, component.parsed);
      const remoteNode: any = remote ? snapshot.nodes[remote.id] : null;
      if (remoteNode?.type && (component.variants.length ? remoteNode.type !== "COMPONENT_SET" : remoteNode.type !== "COMPONENT")) {
        issues.push({ kind: "conflict", key, message: `${component.parsed.name}: component and component-set types differ. Resolve the existing Figma resource explicitly before syncing.` }); continue;
      }
      if (remoteNode?.type === "COMPONENT_SET" && (remoteNode.children?.length !== component.variants.length || component.variants.some(variant => !remoteNode.children?.some((child: any) => child.name === variant.label)))) issues.push({ kind: "conflict", key, message: `${component.parsed.name}: its variant roster changed. Rebuilding this set detaches existing instances; review before replacing it.` });
      if (remote?.codeKey && remote.codeKey !== key) { issues.push({ kind: "conflict", key, message: `${component.parsed.name}: this name belongs to another component. Rename it explicitly before syncing.` }); continue; }
      if (remote && (!known || !known.nodeHash)) issues.push({ kind: "conflict", key, message: `${component.parsed.name}: an existing Figma component has no managed baseline.` });
      if (known && !remote) issues.push({ kind: "conflict", key, message: `${component.parsed.name}: deleted in Figma. Review before recreating it.` });
      const specs = [component.params, component.setParams, ...Object.values(component.variantParams ?? {})];
      if (component.variants.length > 50 || specs.some(spec => spec && Array.isArray(spec.children) && spec.children.length + (spec.text ? 1 : 0) > 50)) {
        issues.push({ kind: "unsupported", key, message: `${component.parsed.name}: its variant or child count exceeds the verified component limit. Split the description into smaller components before syncing.` }); continue;
      }
      if (component.sidecarError) { issues.push({ kind: "unsupported", key, message: `${component.parsed.name}: its Figma description is missing or invalid. Ask your coding assistant to prepare and review it.` }); continue; }
      if (known?.nodeHash && remote && nodeStateHash(snapshot.nodes[remote.id]) !== known.nodeHash) issues.push({ kind: "conflict", key, message: `${component.parsed.name}: the Figma component was edited.` });
      if (known?.sourceHash && known.sourceHash !== component.sourceHash && known.specHash === specHash) {
        issues.push({ kind: "unsupported", key, message: `${component.parsed.name}: implementation changed without an updated Figma description. Review the description before syncing.` }); continue;
      }
      if (!known || known.status !== "synced" || known.specHash !== specHash || !remote || !known.sourceHash || issues.some(issue => issue.kind === "conflict" && issue.key === key)) entries.push({ kind: "component", key, name: component.parsed.name, action: remote ? "update" : "create" });
    }
    for (const [key, known] of Object.entries(manifest.tokens)) if (!tokenKeys.has(key) && snapshot.variables.some(item => item.id === known.figmaVariableId)) issues.push({ kind: "removed", key, message: `${key}: removed or renamed in code. Retained in Figma; review and remove it explicitly in Figma or with the delete_variable MCP tool.` });
    const codeKeys = new Set(parsed.map(item => item.codeKey));
    for (const [key, known] of Object.entries(manifest.components)) if (!codeKeys.has(key) && snapshot.components.some(item => item.id === known.figmaNodeId)) issues.push({ kind: "removed", key, message: `${key}: removed or renamed in code. Retained in Figma; review and remove it explicitly in Figma.` });
    for (const [kind, styles] of [["text", tokens.plan.textStyles], ["effect", tokens.plan.effectStyles]] as const) for (const style of styles) {
      const key = `${kind}:${style.key}`; const known = manifest.styles?.[key];
      const remote = snapshot.styles.find(item => item.kind === kind && ((style.params.codeKey && item.codeKey === style.params.codeKey) || item.name === style.params.name));
      if (remote && (!known || !known.remoteHash)) issues.push({ kind: "conflict", key, message: `${style.key}: an existing Figma style has no managed baseline.` });
      if (known && !remote) issues.push({ kind: "conflict", key, message: `${style.key}: deleted in Figma. Review before recreating it.` });
      if (known?.remoteHash && remote && known.remoteHash !== hashSpec(remote)) issues.push({ kind: "conflict", key, message: `${style.key}: this Figma style was edited.` });
      if (!known || known.valueHash !== hashSpec(style.params) || !remote || issues.some(issue => issue.kind === "conflict" && issue.key === key)) entries.push({ kind: "style", key, name: style.key, action: remote ? "update" : "create" });
    }
    const view: SyncPlan = { id: randomUUID(), fileKey: loadConfig(this.configPath).figma.fileKey, entries, issues, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const fingerprint = createHash("sha256").update(stableStringify({ config: this.raw(), tokens: tokens.plan, source: readFileSync(config.tokensFile, "utf8"), components: components.map(component => ({ ...component, source: readFileSync(resolve(config.componentsDir, component.parsed.file), "utf8"), raw: existsSync(sidecarPathFor(config.componentsDir, component.parsed)) ? readFileSync(sidecarPathFor(config.componentsDir, component.parsed), "utf8") : null })), manifest, snapshot })).digest("hex");
    return { view, fingerprint, config, manifest, tokens: tokens.plan, components, snapshot };
  }
  private async execute(plan: InternalPlan, client: BridgeCaller): Promise<Record<string, unknown>> {
    const variableKeys = writes(plan.view, "token"); const componentKeys = writes(plan.view, "component"); const styleKeys = writes(plan.view, "style");
    if (!plan.view.entries.length) {
      if (plan.view.issues.length) this.record("conflict", `${plan.view.issues.length} items need review; no Figma writes were made.`);
      return { synced: 0, issues: plan.view.issues };
    }
    this.record("sync", `Applying ${plan.view.entries.length} reviewed resource changes.`);
    try {
    const result = await syncTokens(plan.tokens, plan.manifest, client, false, false, () => {}, { variables: variableKeys, styles: styleKeys });
    saveManifest(plan.config.manifestFile, plan.manifest);
    if (result.aborted) { this.record("error", result.aborted); throw new Error(result.aborted); }
    const outcomes = new Map();
    for (const component of plan.components) if (componentKeys.has(component.parsed.codeKey)) {
      const outcome = await processComponent(component, outcomes, { client, manifest: plan.manifest, force: true, dryRun: false, log: () => {} });
      outcomes.set(component.parsed.codeKey, outcome); saveManifest(plan.config.manifestFile, plan.manifest);
    }
    const after = await this.snapshot(client, plan.components, styleKeys.size > 0, plan.snapshot.components.length > 0 || plan.components.length > 0);
    for (const key of variableKeys) {
      const remote = after.variables.find(item => item.codeKey === key || item.id === plan.manifest.tokens[key]?.figmaVariableId);
      const expected = [plan.tokens.primitives, ...(plan.tokens.semanticCollections ?? [plan.tokens.semantic])].flatMap(section => section.variables).find(variable => variable.codeKey === key);
      if (!remote || !expected) throw new Error("A variable write could not be verified. Review a fresh plan.");
      for (const [mode, desired] of Object.entries(expected.values)) {
        const actual = remote.valuesByMode?.[mode];
        if (!actual) throw new Error(`${expected.name}: the written mode could not be verified.`);
        if (typeof desired === "object" && desired !== null && "variable" in desired) {
          const targetName = String((desired as { variable: string }).variable);
          const targets = after.variables.filter(item => item.name === targetName || `${item.collectionName}/${item.name}` === targetName || item.id === targetName);
          if (actual.type !== "VARIABLE_ALIAS" || !targets.some(item => item.id === actual.id)) throw new Error(`${expected.name}: its alias changed while syncing. Review before retrying.`);
        } else {
          const matches = expected.type === "COLOR" ? cssColorToHex(String(actual.value)) === cssColorToHex(String(desired)) : actual.value === desired;
          if (!matches) throw new Error(`${expected.name}: Figma changed while syncing. Its new value was preserved; review before retrying.`);
        }
      }
      if (plan.manifest.tokens[key]) plan.manifest.tokens[key].remoteHash = hashSpec(remote);
    }
    plan.manifest.styles ??= {};
    for (const [kind, styles] of [["text", plan.tokens.textStyles], ["effect", plan.tokens.effectStyles]] as const) for (const style of styles) if (styleKeys.has(`${kind}:${style.key}`)) {
      const remote = after.styles.find(item => item.kind === kind && ((style.params.codeKey && item.codeKey === style.params.codeKey) || item.name === style.params.name));
      verifyStylePatch(kind, style.params, remote);
      if (remote) plan.manifest.styles[`${kind}:${style.key}`] = { valueHash: hashSpec(style.params), remoteHash: hashSpec(remote) };
    }
    for (const component of plan.components) if (componentKeys.has(component.parsed.codeKey)) {
      const entry = plan.manifest.components[component.parsed.codeKey];
      const node: any = entry?.figmaNodeId ? after.nodes[entry.figmaNodeId] : null;
      if (component.variants.length) {
        for (const variant of component.variants) {
          const child = node?.children?.find((item: any) => item.name === variant.label);
          verifyComponentPatch({ ...component.setParams, ...(component.variantParams?.[variant.label] ?? {}) }, child, after.variables, after.components);
        }
      } else verifyComponentPatch(component.params ?? {}, node, after.variables, after.components);
    }
    saveManifest(plan.config.manifestFile, plan.manifest);
    const failed = [...outcomes.values()].filter(outcome => outcome.action === "failed" || outcome.action === "skipped");
    const synced = variableKeys.size + styleKeys.size + [...outcomes.values()].filter(outcome => outcome.action === "synced").length;
    this.record(failed.length ? "error" : "sync", `${synced} ${synced === 1 ? "resource" : "resources"} synced${failed.length ? `; ${failed.length} components need attention` : ""}.`);
    if (failed.length) throw new Error(failed.map(outcome => outcome.error).join("; "));
    return { synced, issues: plan.view.issues };
    } catch (error) {
      for (const key of variableKeys) if (plan.manifest.tokens[key]) delete plan.manifest.tokens[key].remoteHash;
      for (const key of componentKeys) if (plan.manifest.components[key]) { plan.manifest.components[key].nodeHash = null; plan.manifest.components[key].status = "failed"; }
      for (const key of styleKeys) if (plan.manifest.styles) delete plan.manifest.styles[key];
      saveManifest(plan.config.manifestFile, plan.manifest);
      this.record("error", (error as Error).message);
      throw error;
    }
  }

  async prepareComponent(name: string): Promise<Record<string, unknown>> {
    const { config, hasComponents, structured } = this.batchConfig();
    if (!hasComponents) throw new Error("Choose a component folder in project configuration first.");
    const component = parseComponents(config.componentsDir).find(item => item.name === name || item.codeKey === name);
    if (!component) throw new Error("That component is not in this project.");
    const sidecar = loadSidecar(config.componentsDir, component) ?? { layoutMode: "HORIZONTAL", size: { width: 120, height: 40 }, text: { characters: component.name, fontSize: 14 } };
    const source = readFileSync(resolve(config.componentsDir, component.file), "utf8");
    const tokens = await this.tokens(config, structured);
    return { source: source.slice(0, 20_000), sourceTruncated: source.length > 20_000, dependencies: component.dependencies, tokens: [...tokens.index.entries()].slice(0, 200).map(([key, value]) => ({ key, name: value.name, type: value.type })), tokenCount: tokens.index.size, codeKey: component.codeKey, file: component.file, path: relative(config.root, sidecarPathFor(config.componentsDir, component)), variantProps: component.variantProps, sidecar, reviewRequired: true, message: "Review layout, token bindings and variants against the implementation. This is an editable description, not a rendered reconstruction." };
  }
  async saveDescription(name: string, description: unknown): Promise<Record<string, unknown>> {
    return this.serial(() => this.runtime.transaction(loadConfig(this.configPath).figma.fileKey, async () => {
      const { config, hasComponents, structured } = this.batchConfig();
      if (!hasComponents) throw new Error("Choose a component folder first.");
      const component = parseComponents(config.componentsDir).find(item => item.name === name || item.codeKey === name);
      if (!component) throw new Error("That component is not in this project.");
      const sidecar = validateSidecar(description as any, component.name);
      const tokenPlan = await this.tokens(config, structured);
      // Validate token references before saving an agent-authored description.
      const { variantMatrix } = await import("../batch/src/sync.js");
      resolveSidecar(sidecar, variantMatrix(component), tokenPlan.index, component.name);
      const path = this.outputPath(relative(config.root, sidecarPathFor(config.componentsDir, component)));
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, `${JSON.stringify(sidecar, null, 2)}\n`, { flag: "wx", mode: 0o600 }); renameSync(temporary, path); }
      finally { rmSync(temporary, { force: true }); }
      // Explicit description review acknowledges the current implementation, without touching Figma.
      const manifest = loadManifest(config.manifestFile);
      const known = manifest.components[component.codeKey];
      if (known) { known.sourceHash = componentSourceHash(config.componentsDir, component); known.status = "pending"; saveManifest(config.manifestFile, manifest); }
      this.record("description", `${component.name}: reviewed description saved.`);
      return { saved: true, path: relative(config.root, path), next: "Review a fresh sync plan before applying it." };
    }));
  }
}
