import {validateImportedComponent,type ComponentImportOptions} from './component-import.js';
import {importedTokenDocument, type ImportSnapshot} from './token-import.js';
import {discoverProject, readSource} from './discovery.js';
import { deliverSyncNotifications } from "./sync-notifications.js";
import { verifyComponentPatch, verifyStylePatch } from "./verify-write.js";
import { cssColorToHex } from "./core/normalize.js";
import { readActivity, recordActivity, type Activity, type SyncedChange } from "./activity.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runElfCheck } from "../watch/src/check.js";
import { loadConfig } from "./config.js";
import { projectResource, writeProjectConfig } from "./onboarding.js";
import { parseCodebaseTokens, parseProjectTokens } from "./codebase/index.js";
import { hashSpec, loadManifest, saveManifest, stableStringify } from "../batch/src/manifest.js";
import { planTokens, type TokenIndex } from "../batch/src/tokens.js";
import { componentSourceHash, componentSpecHash, planComponent, processComponent, syncTokens } from "../batch/src/sync.js";
import { parseComponents } from "../batch/src/parser.js";
import { loadSidecar, resolveSidecar, sidecarPathFor, validateSidecar } from "../batch/src/sidecar.js";
import { orderComponents } from "../batch/src/graph.js";
import { NODE_STATE_DEPTH, nodeStateHash } from "../batch/src/nodestate.js";
import type { BatchConfig, BridgeCaller, Manifest, ParsedComponent, PlannedComponent, TokensPlan } from "../batch/src/types.js";
import type { BridgeRuntime } from "../mcp/src/runtime.js";

export interface PlanEntry { kind: "token" | "component" | "style"; key: string; name: string; action: "create" | "update"; }
export interface PlanIssue { kind: "conflict" | "unsupported" | "removed"; key: string; message: string; component?: string; action?: "prepare-component"; blocksApply?: boolean; }
export interface SyncPlan { selection?: {kind: PlanEntry["kind"];key:string}; id: string; fileKey: string; entries: PlanEntry[]; issues: PlanIssue[]; expiresAt: string; }
interface Snapshot { collections: any[]; variables: any[]; components: any[]; nodes: Record<string, unknown>; styles: any[]; }
interface InternalPlan { selection?: {kind: PlanEntry["kind"]; key: string}; view: SyncPlan; fingerprint: string; config: BatchConfig; manifest: Manifest; tokens: TokensPlan; components: PlannedComponent[]; snapshot: Snapshot; }
const writes = (plan: SyncPlan, kind: PlanEntry["kind"]): Set<string> => new Set(plan.entries.filter(entry => entry.kind === kind).map(entry => entry.key));

/** The same managed workflow is used by Settings, automatic watch, CLI and MCP. */
export class ProjectService {
  get activity(): Activity[] { return readActivity(this.configPath); }
  private reviewed = new Map<string, InternalPlan>();
  private importReviews = new Map<string,{id:string;path:string;content:string;names:string[];issues:string[];fingerprint:string;expiresAt:string;ids?:string[]}>();
  private componentImports=new Map<string,{options:ComponentImportOptions;fingerprint:string;expires:number;reusePaths:string[]}>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly configPath: string, private readonly runtime: BridgeRuntime) { this.migrate(); }

  private transaction<T>(work: (client: import('../mcp/src/client.js').BridgeClient) => Promise<T>): Promise<T> {
    const config = loadConfig(this.configPath);
    return this.runtime.transaction(config.figma.fileKey, work, {authorization: config.figma.authorization ?? 'strict'});
  }
  async pendingDocument(): Promise<unknown> {
    return this.runtime.control('__elf_document_pending');
  }
  async approveDocument(fileKey: string, ticket: string, optIn: boolean): Promise<unknown> {
    if (!optIn || !/^[a-f0-9]{64}$/.test(ticket) || !/^[A-Za-z0-9_-]{8,128}$/.test(fileKey)) throw new Error('Explicit document approval is required.');
    const pending = await this.pendingDocument() as {file?: {key: string}; ticket?: string} | null;
    if (!pending || pending.file?.key !== fileKey || pending.ticket !== ticket) throw new Error('The open document changed. Review its approval again.');
    const raw = existsSync(this.configPath) ? this.raw() : {figma: {fileKey, source:'bridge'}, codebase:{path:'auto',source:'auto'},runtime:{projectConfigured:false,setupComplete:false}};
    if (raw.figma?.fileKey !== fileKey) throw new Error('The plugin file link does not match this project. Check it before approving.');
    raw.figma.authorization = 'plugin'; raw.figma.source = 'bridge'; raw.runtime = {...raw.runtime, autoSync:false}; this.reviewed.clear();
    writeProjectConfig(this.configPath, raw);
    const result = await this.runtime.control('__elf_document_approve', {fileKey, ticket});
    this.record('description', 'Open Figma document approved for this plugin connection. URL identity was not verified.');
    return result;
  }
  async useStrictAuthorization(): Promise<unknown> {
    const raw = this.raw(); raw.figma.authorization = 'strict'; raw.runtime = {...raw.runtime, autoSync:false}; this.reviewed.clear();
    writeProjectConfig(this.configPath, raw);
    await this.runtime.control('__elf_require_strict', {fileKey:raw.figma.fileKey});
    return {ok:true};
  }
  record(type: Activity["type"], message: string, changes?: SyncedChange[]): void {
    recordActivity(this.configPath, type, message, changes);
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
      const result = await runElfCheck(this.configPath, dirname(this.configPath), Boolean(config.notify));
      if (result.notificationError) this.record("error", result.notificationError);
      this.record(result.status === "failed" ? "error" : "check", result.status === "clean" ? "No drift found." : result.status === "drift" ? `${result.total ?? "Some"} drift items remain.` : result.message ?? "Check failed.");
      return { ...result, report: join(dirname(this.configPath), "drift-report.md") };
    });
  }
  async plan(selection?: {kind: PlanEntry["kind"]; key: string}): Promise<SyncPlan> {
    return this.serial(() => this.transaction( async client => {
      const plan = await this.build(client);
      if (selection) this.selectPlan(plan, selection);
      for (const [id, previous] of this.reviewed) if (Date.parse(previous.view.expiresAt) < Date.now()) this.reviewed.delete(id);
      if (this.reviewed.size >= 20) this.reviewed.delete(this.reviewed.keys().next().value!);
      this.reviewed.set(plan.view.id, plan);
      return plan.view;
    }));
  }
  async apply(id: string, options: { enableAuto?: boolean; overwriteConflicts?: boolean } = {}): Promise<Record<string, unknown>> {
    const result = await this.serial(() => this.transaction( async client => {
      const reviewed = this.reviewed.get(id);
      if (!reviewed || Date.parse(reviewed.view.expiresAt) < Date.now()) throw new Error("This sync plan expired. Review a fresh plan.");
      const fresh = await this.build(client);
      if (reviewed.selection) this.selectPlan(fresh, reviewed.selection);
      if (fresh.fingerprint !== reviewed.fingerprint) throw new Error("Code, configuration, or Figma changed after review. Review a fresh plan before applying.");
      if (fresh.view.issues.some(issue => issue.kind === "conflict" && issue.blocksApply !== false) && !options.overwriteConflicts) throw new Error("Figma has edits. Keep them, or explicitly choose to replace the conflicts in this reviewed plan.");
      if (options.enableAuto && reviewed.selection) throw new Error('Individual sync cannot enable automatic sync. Review the full project first.');
      if (options.enableAuto && loadConfig(this.configPath).intentionalDifferences?.length) throw new Error("Intentional differences are configured. Keep monitoring enabled and review writes individually.");
      if (options.enableAuto && fresh.view.issues.some(issue => issue.kind !== "unsupported")) throw new Error("Resolve conflicts and removed resources before enabling automatic sync.");
      this.reviewed.delete(id);
      const result = await this.execute(fresh, client);
      if (options.enableAuto) {
        const raw = this.raw(); writeProjectConfig(this.configPath, { ...raw, runtime: { ...raw.runtime, autoSync: true } });
      }
      return result;
    }));
    try { await deliverSyncNotifications(this.configPath); } catch { this.record("error", "Sync completed, but its notification could not be delivered. Delivery will be retried."); }
    return result;
  }
  async autoSync(): Promise<Record<string, unknown>> {
    return this.serial(() => this.transaction( async client => {
      if (!this.automatic()) return { synced: 0, paused: false, issues: [] };
      if (loadConfig(this.configPath).intentionalDifferences?.length) return {synced: 0, paused: true, conflicts: ["Intentional differences require reviewed sync."]};
      const plan = await this.build(client);
      if (!this.automatic()) return { synced: 0, paused: false, issues: [] };
      if (plan.view.issues.some(issue => issue.kind === "conflict" || issue.kind === "removed")) {
        this.record("conflict", "Sync paused: Figma edits or removed resources need review.");
        return { synced: 0, conflicts: plan.view.issues, paused: true };
      }
      return this.execute(plan, client);
    }));
  }
  async resources(): Promise<Record<string, unknown>> {
    return this.serial(() => this.transaction( async client => {
      const { config } = this.batchConfig(); const manifest = loadManifest(config.manifestFile);
      const { variables } = await client.call<{ variables: any[] }>("list_variables");
      const styles = Object.keys(manifest.styles ?? {}).length ? (await client.call<{styles: any[]}>("list_styles")).styles : [];
      const components = Object.values(manifest.components).some(entry => entry.figmaNodeId) ? (await client.call<{components: any[]}>("list_components", {deep: true})).components : [];
      const fileKey = loadConfig(this.configPath).figma.fileKey;
      const fileUrl = `https://www.figma.com/design/${encodeURIComponent(fileKey)}`;
      return { fileUrl, checkedAt: new Date().toISOString(), resources: [
        ...Object.entries(manifest.tokens).map(([key, entry]) => {
          const remote = variables.find(item => item.id === entry.figmaVariableId);
          return {kind: "token", key, name: remote?.name ?? key, figmaId: entry.figmaVariableId, location: remote?.collectionName ?? "Variables", value: remote ? JSON.stringify(remote.valuesByMode) : "Unavailable", verified: Boolean(remote && entry.remoteHash && hashSpec(remote) === entry.remoteHash), figmaUrl: fileUrl};
        }),
        ...Object.entries(manifest.components).filter(([, entry]) => entry.figmaNodeId).map(([key, entry]) => ({kind: "component", key, name: components.find(item => item.id === entry.figmaNodeId)?.name ?? key, figmaId: entry.figmaNodeId, location: "Canvas", value: `Last recorded status: ${entry.status}`, verified: false, recorded: entry.status === "synced", figmaUrl: `${fileUrl}?node-id=${encodeURIComponent(entry.figmaNodeId!)}`})),
        ...Object.entries(manifest.styles ?? {}).map(([key, entry]) => {
          const split = key.indexOf(":"); const kind = key.slice(0, split); const name = key.slice(split + 1);
          const remote = styles.find(item => item.kind === kind && (item.codeKey === name || item.name === name));
          return {kind: "style", key, name: remote?.name ?? name, location: `${kind} styles`, value: remote ? JSON.stringify(remote).slice(0, 4000) : "Unavailable", verified: Boolean(remote && hashSpec(remote) === entry.remoteHash), figmaUrl: fileUrl};
        }),
      ] };
    }));
  }
  private async importSnapshot(client:BridgeCaller):Promise<ImportSnapshot> {
    const collections = await client.call<{collections:any[]}>('list_collections');
    const variables = await client.call<{variables:any[]}>('list_variables');
    return {collections:collections.collections,variables:variables.variables};
  }
  private importSources(): {paths:string[];hash:string} {
    const root = realpathSync(dirname(this.configPath));
    const drift = loadConfig(this.configPath);
    const paths = [...new Set([...discoverProject(root).tokens,...(drift.codebase.paths ?? [drift.codebase.path]).map(path => resolve(root,path))])].filter(path => resolve(path)!==resolve(this.configPath)).sort();
    return {paths,hash:hashSpec({config:readSource(this.configPath),sources:paths.map(path => [path,readSource(path)]),connection:{at:this.runtime.connection.status.connectedAt,id:this.runtime.connection.status.file?.authorizationId}})};
  }
  async planTokenImport(path='figma.tokens.json', ids?:string[]):Promise<Record<string,unknown>> {
    return this.serial(() => this.transaction(async client => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tokens\.json$/.test(path) || path.includes('..')) throw new Error('Use a new filename in the project root, such as figma.tokens.json.');
      const target=this.outputPath(path);
      if (existsSync(target)) throw new Error('The import output already exists. Choose a new filename; imports never overwrite existing files.');
      const sources=this.importSources();
      const existing = new Set<string>();
      for (const source of sources.paths) for (const token of await parseCodebaseTokens('auto',source)) existing.add(token.name);
      const snapshot=await this.importSnapshot(client);
      const draft=importedTokenDocument(snapshot,loadConfig(this.configPath).figma.fileKey,existing,ids,loadConfig(this.configPath).nameMapping);
      const view={id:randomUUID(),path,content:draft.content,names:draft.names,issues:draft.issues,expiresAt:new Date(Date.now()+10*60_000).toISOString()};
      for (const [id,old] of this.importReviews) if (Date.parse(old.expiresAt)<Date.now()) this.importReviews.delete(id);
      if (this.importReviews.size>=20) this.importReviews.delete(this.importReviews.keys().next().value!);
      this.importReviews.set(view.id,{...view,ids,fingerprint:hashSpec({sources:sources.hash,snapshot})});
      return {...view,detectedFormats:[...new Set(sources.paths.map(source => source.endsWith('.css')?'CSS':source.endsWith('.json')?'JSON':'Tailwind'))],format:'Elf JSON',limitations:['Creates a new JSON file; does not rewrite CSS, Tailwind, or existing tokens.','Imported variables are reference baselines. Reverse writes require a separate reviewed migration.','Boolean and unclassified numeric values are retained, but are not compared by the drift engine.']};
    }));
  }
  async applyTokenImport(id:string):Promise<Record<string,unknown>> {
    return this.serial(() => this.transaction(async client => {
      const plan=this.importReviews.get(id);
      if (!plan || Date.parse(plan.expiresAt)<Date.now()) throw new Error('This token import review expired. Prepare it again.');
      if (!plan.names.length) throw new Error('There are no new tokens to import.');
      const target=this.outputPath(plan.path);
      if (existsSync(target)) throw new Error('The import file now exists. Review a new output path.');
      const snapshot=await this.importSnapshot(client);
      if (hashSpec({sources:this.importSources().hash,snapshot})!==plan.fingerprint) throw new Error('Code, configuration, connection, or Figma changed. Review the import again.');
      this.importReviews.delete(id);
      if (this.automatic()) this.setMonitoring();
      writeFileSync(target,plan.content,{flag:'wx',mode:0o600});
      this.reviewed.clear();
      this.record('description',`${plan.names.length} Figma tokens imported into ${plan.path}.`);
      return {imported:plan.names.length,path:plan.path};
    }));
  }
  private importEnvironment():{frameworks:string[];libraries:string[];dependencies:string[];components:{name:string;codeKey:string;file:string}[];fingerprint:string} {
    const root=realpathSync(dirname(this.configPath));
    const path=join(root,'package.json');
    const manifest=existsSync(path)?JSON.parse(readSource(path)):{};
    const dependencies=Object.keys({...manifest.dependencies,...manifest.devDependencies}).sort();
    const {config,hasComponents}=this.batchConfig();
    const components=hasComponents?parseComponents(config.componentsDir,config.componentFiles).filter(item=>item.deprecated===undefined).map(item=>({name:item.name,codeKey:item.codeKey,file:relative(root,resolve(config.componentsDir,item.file))})):[];
    return {frameworks:[...(dependencies.includes('react')||components.some(item=>/\.[jt]sx$/.test(item.file))?['react']:[]),...(dependencies.includes('vue')||components.some(item=>item.file.endsWith('.vue'))?['vue']:[]),...(dependencies.includes('svelte')||components.some(item=>item.file.endsWith('.svelte'))?['svelte']:[])],libraries:dependencies.filter(name=>/^(?:@mui\/material|@chakra-ui\/react|@radix-ui\/react-[a-z-]+|@heroui\/react|antd|@mantine\/core)$/.test(name)),dependencies,components,fingerprint:hashSpec({manifest,components:components.map(item=>({...item,source:readSource(resolve(root,item.file))})),sources:this.importSources().hash})};
  }
  async listComponentImports():Promise<Record<string,unknown>> {
    return this.serial(()=>this.transaction(async client=>{
      const {components}=await client.call<{components:any[]}>('list_components',{deep:true});
      const environment=this.importEnvironment();
      return {components:components.map(item=>({id:item.id,name:item.name})),frameworks:environment.frameworks,libraries:environment.libraries,reusable:environment.components.filter(item=>/\.(?:jsx|tsx|js)$/.test(item.file)),supportedFrameworks:['react'],limitations:['React TSX is the first supported output. No dependencies are installed.','Figma does not capture complete behavior, accessibility, or responsive intent.']};
    }));
  }
  async prepareComponentImport(options:ComponentImportOptions):Promise<Record<string,unknown>> {
    return this.serial(()=>this.transaction(async client=>{
      if (!options || typeof options.nodeId!=='string' || options.framework!=='react' || typeof options.library!=='string' || typeof options.path!=='string' || !Array.isArray(options.reuse) || options.reuse.length>50 || options.reuse.some(key=>typeof key!=='string')) throw new Error('Confirm a Figma component, React framework, library, output path, and reuse choices.');
      const root=realpathSync(dirname(this.configPath));
      if(options.path.split(/[\\/]/).some(part=>part==='..'||part.startsWith('.')&&part!=='.'||['node_modules','vendor','dist','build'].includes(part)))throw new Error('Choose a source folder, not project metadata, dependencies, or generated output.');
      const target=this.outputPath(options.path);
      if (isAbsolute(options.path) || !/^[A-Z][A-Za-z0-9]*\.tsx$/.test(basename(options.path))) throw new Error('Choose a new PascalCase .tsx file inside the project.');
      if (existsSync(target)) throw new Error('This output already exists. Choose a new filename; existing components are never overwritten.');
      const environment=this.importEnvironment();
      if (options.library!=='native' && !environment.libraries.includes(options.library)) throw new Error('Select native elements or a supported library already declared in this project.');
      const reusable=options.reuse.map(key=>environment.components.find(item=>item.codeKey===key));
      if(reusable.some(item=>item && !/\.(?:jsx|tsx|js)$/.test(item.file)))throw new Error('Choose React-compatible local components for reuse.');
      if (reusable.some(item=>!item)) throw new Error('Select existing local components for reuse.');
      const refs=await client.call<{components:any[]}>('list_components',{deep:true});
      if (!refs.components.some(item=>item.id===options.nodeId)) throw new Error('Select a component from the connected Figma file.');
      const {node}=await client.call<{node:any}>('get_node',{nodeId:options.nodeId,depth:6});
      if (!node || !['COMPONENT','COMPONENT_SET'].includes(node.type)) throw new Error('This node is not a Figma component or component set.');
      if (Buffer.byteLength(JSON.stringify(node))>100000) throw new Error('This component is too large for a bounded draft. Split it into smaller components.');
      const snapshot=await this.importSnapshot(client);
      const context={variableCount:snapshot.variables.length,variablesTruncated:snapshot.variables.length>200,readLimits:{depth:6,childrenPerNode:50},node,variables:snapshot.variables.slice(0,200),collections:snapshot.collections,reuse:reusable,options:{...options},exportName:basename(options.path,'.tsx')};
      if (Buffer.byteLength(JSON.stringify(context))>180000) throw new Error('Component and token context exceeds the review limit.');
      for (const [id,review] of this.componentImports) if (review.expires<Date.now()) this.componentImports.delete(id);
      if (this.componentImports.size>=20) this.componentImports.delete(this.componentImports.keys().next().value!);
      const id=randomUUID();
      this.componentImports.set(id,{options:{...options,reuse:[...options.reuse]},fingerprint:hashSpec({environment:environment.fingerprint,node,snapshot}),expires:Date.now()+30*60_000,reusePaths:reusable.map(item=>resolve(root,item!.file))});
      return {id,...context,limitations:['Editable visual starting point; not a complete or pixel-perfect reconstruction.','Confirm semantics, keyboard/focus behavior, responsive layout, variants, and library APIs.','Syntax and restricted API checks do not replace a security or accessibility review.']};
    }));
  }
  async validateComponentImport(id:string,code:unknown):Promise<Record<string,unknown>> {
    const review=this.componentImports.get(id);
    if (!review || review.expires<Date.now()) throw new Error('Prepare a fresh component import.');
    validateImportedComponent(code,review.options,realpathSync(dirname(this.configPath)),review.reusePaths);
    return {valid:true};
  }
  async applyComponentImport(id:string,code:unknown):Promise<Record<string,unknown>> {
    return this.serial(()=>this.transaction(async client=>{
      const review=this.componentImports.get(id);
      if (!review || review.expires<Date.now()) throw new Error('The component import expired. Prepare a new draft.');
      const {node}=await client.call<{node:unknown}>('get_node',{nodeId:review.options.nodeId,depth:6});
      const snapshot=await this.importSnapshot(client);
      if (hashSpec({environment:this.importEnvironment().fingerprint,node,snapshot})!==review.fingerprint) throw new Error('Code, configuration, connection, or Figma changed. Prepare a new component import.');
      const target=this.outputPath(review.options.path);
      if (existsSync(target)) throw new Error('This component file now exists. Nothing was overwritten.');
      const source=validateImportedComponent(code,review.options,realpathSync(dirname(this.configPath)),review.reusePaths);
      if (this.automatic()) this.setMonitoring();
      writeFileSync(target,source.endsWith('\n')?source:source+'\n',{flag:'wx',mode:0o600});
      this.componentImports.delete(id);this.reviewed.clear();
      this.record('description',`Figma component imported into ${review.options.path}. Review behavior and accessibility before using it.`);
      return {path:review.options.path,created:true};
    }));
  }
  generatedPaths(): string[] { const { config } = this.batchConfig(); return [config.manifestFile, realpathSync(this.configPath), join(config.root, "drift-report.md"), join(config.root, "drift-status.json")]; }
  watchPaths(): string[] {
    const { config, hasComponents } = this.batchConfig();
    const drift = loadConfig(this.configPath);
    return [...new Set([config.root, ...(drift.codebase.paths ?? []), this.resource(config.root, drift.codebase.path), config.tokensFile, ...(hasComponents ? [config.componentsDir] : [])])];
  }
  private batchConfig(): { config: BatchConfig; hasComponents: boolean; structured: boolean } {
    this.migrate();
    const raw = this.raw(); const drift = loadConfig(this.configPath); const root = realpathSync(dirname(resolve(this.configPath)));
    const sync = raw.sync ?? {};
    const tokenPath = sync.tokens ?? drift.codebase.path;
    const components = sync.components ?? raw.components?.path ?? drift.components?.path;
    const manifest = sync.manifest ?? raw.components?.manifest ?? "elf.manifest.json";
    const config: BatchConfig = {
      configPath: this.configPath, root, tokensFile: this.resource(root, tokenPath),
      componentsDir: components ? this.resource(root, components, true) : root,
      ...(drift.components?.files ? {componentFiles: drift.components.files} : {}),
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
    const importedIndex:TokenIndex=new Map();const importedIssues:PlanIssue[]=[];
    for (const path of loadConfig(this.configPath).codebase.paths ?? []) if (path.endsWith('.json')) {
      const data=JSON.parse(readSource(path));
      if (data.$elfFigmaImport===1) importedIssues.push({kind:'unsupported',key:`import:${basename(path)}`,message:`${basename(path)}: imported Figma references are read for checks and component bindings; reverse token writes require a reviewed migration.`});
      if (data.$elfFigmaImport===1) for (const [name,item] of Object.entries(data.tokens) as [string,any][]) {
        const variable=data.source?.variables?.find((value:any)=>value.id===item.figmaId);
        if (!variable || typeof variable.name!=='string') throw new Error('Imported token metadata is invalid.');
        importedIndex.set(name,{codeKey:name,name:variable.name,type:item.type,literal:item.value});

      }
    }
    if (structured) {
      const planned=planTokens(config.tokensFile,config);
      return {...planned,index:new Map([...importedIndex,...planned.index]),unsupported:importedIssues};
    }
    // Preserve rich token aliases/modes when the source already uses the batch format.
    if (config.tokensFile.endsWith(".json") && !loadConfig(this.configPath).codebase.paths?.slice(1).length) {
      try { const planned = planTokens(config.tokensFile, config); if (planned.index.size) return { ...planned, unsupported: [] }; } catch {}
    }
    const drift = loadConfig(this.configPath);
    const source = drift.codebase.paths ? await parseProjectTokens(drift.codebase) : await parseCodebaseTokens(drift.codebase.source, config.tokensFile);
    const variables: TokensPlan["primitives"]["variables"] = []; const index: TokenIndex = new Map(importedIndex); const unsupported: PlanIssue[] = [...importedIssues];
    const importedNames = new Set(importedIndex.keys());
    for (const token of source) {
      if (token.mode !== undefined || importedNames.has(token.name)) continue;
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
    const parsed = hasComponents ? orderComponents(parseComponents(config.componentsDir, config.componentFiles)) : [];
    const components = parsed.map(component => planComponent(config, tokens.index, component));
    const manifest = loadManifest(config.manifestFile);
    const snapshot = await this.snapshot(client, components, tokens.plan.textStyles.length + tokens.plan.effectStyles.length > 0, hasComponents || Object.keys(manifest.components).length > 0);
    const entries: PlanEntry[] = []; const issues = [...tokens.unsupported];
    const sections = [tokens.plan.primitives, ...(tokens.plan.semanticCollections ?? [tokens.plan.semantic])];
    const deprecations = loadConfig(this.configPath).deprecations;
    const deprecated = (type: "token" | "component", name: string, key: string): boolean => deprecations.some(item => item.type === type && (item.name === name || item.name === key));
    const tokenKeys = new Set<string>();
    for (const section of sections) for (const variable of section.variables) {
      tokenKeys.add(variable.codeKey);
      if (deprecated("token", variable.name, variable.codeKey)) { issues.push({kind: "unsupported", key: variable.codeKey, message: `${variable.name}: deprecated; retained without automatic writes.`}); continue; }
      const known = manifest.tokens[variable.codeKey];
      const remote = snapshot.variables.find(item => item.codeKey === variable.codeKey || (item.collectionName === section.collection && item.name === variable.name));
      if (remote?.codeKey && remote.codeKey !== variable.codeKey) { issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: this name is already owned by another code token.` }); continue; }
      if (remote && (!known || !known.remoteHash)) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: an existing Figma variable has no managed baseline. Review before taking ownership.` });
      if (known && !remote) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: deleted in Figma. Review before recreating it.` });
      if (known?.remoteHash && remote && known.remoteHash !== hashSpec(remote)) issues.push({ kind: "conflict", key: variable.codeKey, message: `${variable.name}: Figma changed since the last managed sync.` });
      if (!known || known.valueHash !== hashSpec(variable) || !remote || issues.some(issue => issue.kind === "conflict" && issue.key === variable.codeKey)) entries.push({ kind: "token", key: variable.codeKey, name: variable.name, action: remote ? "update" : "create" });
    }
    for (const component of components) {
      if (component.parsed.deprecated !== undefined || deprecated("component", component.parsed.name, component.parsed.codeKey)) { issues.push({kind: "unsupported", key: component.parsed.codeKey, message: `${component.parsed.name}: deprecated; retained without automatic writes.`}); continue; }
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
      if (component.sidecarError) { issues.push({ kind: "unsupported", key, component: component.parsed.codeKey, action: "prepare-component", message: `${component.parsed.name}: prepare and review its Figma description before syncing.` }); continue; }
      if (known?.nodeHash && remote && nodeStateHash(snapshot.nodes[remote.id]) !== known.nodeHash) issues.push({ kind: "conflict", key, message: `${component.parsed.name}: the Figma component was edited.` });
      if (known?.sourceHash && known.sourceHash !== component.sourceHash && known.specHash === specHash) {
        issues.push({ kind: "unsupported", key, component: component.parsed.codeKey, action: "prepare-component", message: `${component.parsed.name}: implementation changed without an updated Figma description. Review the description before syncing.` }); continue;
      }
      if (!known || known.status !== "synced" || known.specHash !== specHash || !remote || !known.sourceHash || issues.some(issue => issue.kind === "conflict" && issue.key === key)) entries.push({ kind: "component", key, name: component.parsed.name, action: remote ? "update" : "create" });
    }
    for (const [key, known] of Object.entries(manifest.tokens)) if (!tokenKeys.has(key) && snapshot.variables.some(item => item.id === known.figmaVariableId)) issues.push({ kind: "removed", key, message: `${key}: removed or renamed in code. Retained in Figma; review and remove it explicitly in Figma or with the delete_variable MCP tool.` });
    const codeKeys = new Set(parsed.map(item => item.codeKey));
    for (const [key, known] of Object.entries(manifest.components)) if (!codeKeys.has(key) && snapshot.components.some(item => item.id === known.figmaNodeId)) issues.push({ kind: "removed", key, message: `${key}: removed or renamed in code. Retained in Figma; review and remove it explicitly in Figma.` });
    for (const [kind, styles] of [["text", tokens.plan.textStyles], ["effect", tokens.plan.effectStyles]] as const) for (const style of styles) {
      const key = `${kind}:${style.key}`;
      if (deprecated("token", typeof style.params.name === "string" ? style.params.name : style.key, style.key) || deprecated("token", style.key, key)) { issues.push({kind: "unsupported", key, message: `${style.key}: deprecated; retained without automatic writes.`}); continue; }
      const known = manifest.styles?.[key];
      const remote = snapshot.styles.find(item => item.kind === kind && ((style.params.codeKey && item.codeKey === style.params.codeKey) || item.name === style.params.name));
      if (remote && (!known || !known.remoteHash)) issues.push({ kind: "conflict", key, message: `${style.key}: an existing Figma style has no managed baseline.` });
      if (known && !remote) issues.push({ kind: "conflict", key, message: `${style.key}: deleted in Figma. Review before recreating it.` });
      if (known?.remoteHash && remote && known.remoteHash !== hashSpec(remote)) issues.push({ kind: "conflict", key, message: `${style.key}: this Figma style was edited.` });
      if (!known || known.valueHash !== hashSpec(style.params) || !remote || issues.some(issue => issue.kind === "conflict" && issue.key === key)) entries.push({ kind: "style", key, name: style.key, action: remote ? "update" : "create" });
    }
    // Keep conflicts on a planned component's dependencies blocking, while
    // unrelated unsupported components remain untouched and don't block a
    // separately reviewed write (for example a new Divider).
    const byKey = new Map(components.map(component => [component.parsed.codeKey, component]));
    const relevant = new Set(entries.map(entry => entry.key));
    const pending = [...relevant];
    while (pending.length) {
      const component = byKey.get(pending.pop()!);
      if (!component) continue;
      const specs = [component.params, component.setParams, ...Object.values(component.variantParams ?? {})];
      const children = specs.flatMap(spec => Array.isArray(spec?.children) ? spec.children.map((child: any) => child.component).filter((key: unknown): key is string => typeof key === "string") : []);
      for (const reference of [...component.parsed.dependencies, ...children]) {
        const target = byKey.get(reference) ?? components.find(item => item.parsed.name === reference);
        if (target && !relevant.has(target.parsed.codeKey)) {relevant.add(target.parsed.codeKey); pending.push(target.parsed.codeKey);}
      }
    }
    for (const issue of issues) if (issue.kind === "conflict") issue.blocksApply = !byKey.has(issue.key) || relevant.has(issue.key);
    const view: SyncPlan = { id: randomUUID(), fileKey: loadConfig(this.configPath).figma.fileKey, entries, issues, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    const fingerprint = createHash("sha256").update(stableStringify({ connectionIdentity: {connectedAt: this.runtime.connection.status.connectedAt, authorizationId: this.runtime.connection.status.file?.authorizationId}, config: this.raw(), tokens: tokens.plan, source: [...new Set([config.tokensFile, ...(loadConfig(this.configPath).codebase.paths ?? [])])].map(path => readFileSync(path, "utf8")), components: components.map(component => ({ ...component, source: readFileSync(resolve(config.componentsDir, component.parsed.file), "utf8"), raw: existsSync(sidecarPathFor(config.componentsDir, component.parsed)) ? readFileSync(sidecarPathFor(config.componentsDir, component.parsed), "utf8") : null })), manifest, snapshot })).digest("hex");
    return { view, fingerprint, config, manifest, tokens: tokens.plan, components, snapshot };
  }
  private selectPlan(plan: InternalPlan, selection: {kind: PlanEntry["kind"]; key: string}): void {
    if (!['token','component','style'].includes(selection.kind) || typeof selection.key !== 'string' || !selection.key) throw new Error('Select one supported resource.');
    const selected = new Set<string>();
    const include = (kind: PlanEntry['kind'], key: string): void => {
      const id = `${kind}:${key}`; if (selected.has(id)) return; selected.add(id);
      if (kind === 'component') {
        const component = plan.components.find(item => item.parsed.codeKey === key);
        if (!component) throw new Error('This component is no longer in the project.');
        const visit = (value: unknown): void => {
          if (typeof value === 'string') {
            const ref = value.replace(/^\{(.*)\}$/, '$1');
            const variable = [plan.tokens.primitives, ...(plan.tokens.semanticCollections ?? [plan.tokens.semantic])].flatMap(section => section.variables).find(item => item.codeKey === ref || item.name === ref);
            if (variable) include('token', variable.codeKey);
          } else if (value && typeof value === 'object') for (const [field, child] of Object.entries(value)) {
            if (field === 'component' && typeof child === 'string') {
              const target = plan.components.find(item => item.parsed.codeKey === child || item.parsed.name === child);
              if (target) include('component', target.parsed.codeKey);
            } else if (!['characters','name','codeKey','layoutMode'].includes(field)) visit(child);
          }
        };
        visit(component.sidecar);
        for (const dep of component.parsed.dependencies) include('component', dep);
        if (key !== selection.key && component.sidecarError) throw new Error(`${component.parsed.name}: prepare and review this required dependency's description before syncing ${selection.key}.`);
      }
      if (kind === 'style') {
        const style = [...plan.tokens.textStyles.map(item => ({...item,kind:'text'})), ...plan.tokens.effectStyles.map(item => ({...item,kind:'effect'}))].find(item => `${item.kind}:${item.key}` === key);
        const visit = (value: unknown): void => {
          if (typeof value === 'string') {
            const ref = value.replace(/^\{(.*)\}$/, '$1');
            const variable = [plan.tokens.primitives,...(plan.tokens.semanticCollections ?? [plan.tokens.semantic])].flatMap(section => section.variables).find(item => item.name === ref || item.codeKey === ref);
            if (variable) include('token',variable.codeKey);
          } else if (value && typeof value === 'object') Object.values(value).forEach(visit);
        }; visit(style?.params);
      }
      if (kind === 'token') {
        const variables = [plan.tokens.primitives, ...(plan.tokens.semanticCollections ?? [plan.tokens.semantic])].flatMap(section => section.variables);
        const variable = variables.find(item => item.codeKey === key);
        for (const value of Object.values(variable?.values ?? {})) if (value && typeof value === 'object' && 'variable' in value) {
          const target = variables.find(item => item.name === (value as any).variable || item.codeKey === (value as any).variable);
          if (target) include('token', target.codeKey);
        }
      }
    };
    include(selection.kind, selection.key);
    plan.selection = {...selection}; plan.view.selection={...selection};
    plan.view.entries = plan.view.entries.filter(entry => selected.has(`${entry.kind}:${entry.key}`));
    plan.view.issues = plan.view.issues.filter(issue => [...selected].some(id => id.slice(id.indexOf(':') + 1) === issue.key));
    for (const issue of plan.view.issues) if (issue.kind === 'conflict') issue.blocksApply = true;
  }
  private async execute(plan: InternalPlan, client: BridgeCaller): Promise<Record<string, unknown>> {
    const variableKeys = writes(plan.view, "token"); const componentKeys = writes(plan.view, "component"); const styleKeys = writes(plan.view, "style");
    if (!plan.view.entries.length) {
      if (plan.view.issues.length) this.record("conflict", `${plan.view.issues.length} items need review; no Figma writes were made.`);
      return { synced: 0, issues: plan.view.issues };
    }
    this.record("sync", `Applying ${plan.view.entries.length} reviewed resource changes.`);
    try {
    const result = await syncTokens(plan.tokens, plan.manifest, client, true, false, () => {}, { variables: variableKeys, styles: styleKeys });
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
    const describe = (entry: PlanEntry, snapshot: Snapshot): string | null => {
      const resource = entry.kind === "token" ? snapshot.variables.find(item => item.codeKey === entry.key || item.id === plan.manifest.tokens[entry.key]?.figmaVariableId)
        : entry.kind === "component" ? snapshot.nodes[plan.manifest.components[entry.key]?.figmaNodeId ?? ""] : snapshot.styles.find(item => {
          const kind = entry.key.startsWith("text:") ? "text" : "effect";
          const spec = (kind === "text" ? plan.tokens.textStyles : plan.tokens.effectStyles).find(style => `${kind}:${style.key}` === entry.key);
          return item.kind === kind && spec && ((spec.params.codeKey && item.codeKey === spec.params.codeKey) || item.name === spec.params.name);
        });
      if (!resource) return null;
      return JSON.stringify(entry.kind === "token" ? resource.valuesByMode : resource).slice(0, 1000);
    };
    const changes = plan.view.entries.filter(entry => entry.kind !== "component" || outcomes.get(entry.key)?.action === "synced").map(entry => ({...entry, before: describe(entry, plan.snapshot), after: describe(entry, after) ?? "Verified updated properties"}));
    this.record(failed.length ? "error" : "sync", `${synced} ${synced === 1 ? "resource" : "resources"} synced${failed.length ? `; ${failed.length} components need attention` : ""}.`, changes);
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

  private descriptionRevision(config: BatchConfig, component: ParsedComponent): string {
    const path = this.outputPath(relative(config.root, sidecarPathFor(config.componentsDir, component)));
    const stat = lstatSync(path, {throwIfNoEntry: false});
    if (stat && stat.size > 128_000) throw new Error("This component description is too large to review in Elf.");
    return createHash("sha256").update(JSON.stringify({source: componentSourceHash(config.componentsDir, component), description: stat ? readFileSync(path, "utf8") : null})).digest("hex");
  }
  async listComponents(): Promise<Record<string, unknown>> {
    const { config, hasComponents, structured } = this.batchConfig();
    const tokens = await this.tokens(config, structured);
    const deprecations = loadConfig(this.configPath).deprecations;
    return { components: hasComponents ? parseComponents(config.componentsDir, config.componentFiles).map(item => {
      const planned = planComponent(config, tokens.index, item);
      return {name:item.name, codeKey:item.codeKey, file:item.file, deprecated:item.deprecated !== undefined || deprecations.some(entry => entry.type === 'component' && (entry.name === item.name || entry.name === item.codeKey)), descriptionStatus:planned.sidecarError ? 'needs-review' : 'ready', suggestion:planned.sidecarError ? 'Generate or prepare a Figma description before syncing.' : undefined};
    }) : [] };
  }
  async validateDescription(name: string, description: unknown, reviewHash: string): Promise<Record<string, unknown>> {
    const { config, structured, hasComponents } = this.batchConfig();
    const component = hasComponents ? parseComponents(config.componentsDir, config.componentFiles).find(item => item.name === name || item.codeKey === name) : undefined;
    if (!component || reviewHash !== this.descriptionRevision(config, component)) throw new Error("The component or description changed. Prepare it again.");
    const sidecar = validateSidecar(description as any, component.name);
    const tokens = await this.tokens(config, structured);
    const { variantMatrix } = await import("../batch/src/sync.js");
    resolveSidecar(sidecar, variantMatrix(component), tokens.index, component.name);
    return { valid: true, description: sidecar };
  }
  async prepareComponent(name: string): Promise<Record<string, unknown>> {
    const { config, hasComponents, structured } = this.batchConfig();
    if (!hasComponents) throw new Error("No component source files were discovered in this project. Add a component and try again.");
    const component = parseComponents(config.componentsDir, config.componentFiles).find(item => item.name === name || item.codeKey === name);
    if (!component) throw new Error("That component is not in this project.");
    const reviewHash = this.descriptionRevision(config, component);
    let sidecar; let warning: string | null = null; let existing = false;
    try {const loaded = loadSidecar(config.componentsDir, component); sidecar = loaded ? validateSidecar(loaded, component.name) : null; existing = Boolean(sidecar);}
    catch {warning = "The existing description is invalid. Saving this reviewed draft replaces it; cancelling leaves it untouched.";}
    sidecar ??= { layoutMode: "HORIZONTAL", size: { width: 120, height: 40 }, text: { characters: component.name, fontSize: 14 } };
    const source = readFileSync(resolve(config.componentsDir, component.file), "utf8");
    const tokens = await this.tokens(config, structured);
    try {const {variantMatrix} = await import("../batch/src/sync.js"); resolveSidecar(sidecar, variantMatrix(component), tokens.index, component.name);}
    catch (error) {warning = [warning, `Review required: ${(error as Error).message.slice(0, 400)}`].filter(Boolean).join(" ");}
    return { name: component.name, reviewHash, existing, warning, source: source.slice(0, 20_000), sourceTruncated: source.length > 20_000, dependencies: component.dependencies, tokens: [...tokens.index.entries()].slice(0, 200).map(([key, value]) => ({ key, name: value.name, type: value.type })), tokenCount: tokens.index.size, codeKey: component.codeKey, file: component.file, path: relative(config.root, sidecarPathFor(config.componentsDir, component)), variantProps: component.variantProps, sidecar, reviewRequired: true, message: "Review layout, token bindings and variants against the implementation. This is an editable description, not a rendered reconstruction." };
  }
  async saveDescription(name: string, description: unknown, reviewHash?: string): Promise<Record<string, unknown>> {
    return this.serial(() => this.transaction( async () => {
      const { config, hasComponents, structured } = this.batchConfig();
      if (!hasComponents) throw new Error("No component source files were discovered in this project. Add a component and try again.");
      const component = parseComponents(config.componentsDir, config.componentFiles).find(item => item.name === name || item.codeKey === name);
      if (!component) throw new Error("That component is not in this project.");
      if (reviewHash !== undefined && reviewHash !== this.descriptionRevision(config, component)) throw new Error("The component or its description changed after preparation. Prepare it again before saving.");
      const sidecar = validateSidecar(description as any, component.name);
      const tokenPlan = await this.tokens(config, structured);
      // Validate token references before saving an agent-authored description.
      const { variantMatrix } = await import("../batch/src/sync.js");
      resolveSidecar(sidecar, variantMatrix(component), tokenPlan.index, component.name);
      const path = this.outputPath(relative(config.root, sidecarPathFor(config.componentsDir, component)));
      // A sidecar save must not trigger automatic Figma writes before a fresh plan.
      if (this.automatic()) this.setMonitoring();
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
