import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { orderComponents } from "./graph.js";
import { hashSpec, loadManifest, saveManifest } from "./manifest.js";
import { NODE_STATE_DEPTH, nodeStateHash } from "./nodestate.js";
import { COMPONENT_EXTENSIONS, parseComponents } from "./parser.js";
import { loadSidecar, resolveSidecar, sidecarPathFor, validateSidecar } from "./sidecar.js";
import { planTokens, type TokenIndex } from "./tokens.js";
import type {
  BatchConfig,
  BridgeCaller,
  Manifest,
  ParsedComponent,
  PlannedComponent,
  SidecarSpec,
  TokensPlan,
  Variant,
} from "./types.js";

export interface SyncOptions {
  config: BatchConfig;
  /** null means dry-run: nothing is written, no bridge call is made. */
  client: BridgeCaller | null;
  force?: boolean;
  only?: string;
  chunkSize?: number;
  log?: (line: string) => void;
}

export type ComponentAction = "synced" | "unchanged" | "failed" | "skipped" | "pending";

export interface ComponentOutcome {
  name: string;
  codeKey: string;
  file: string;
  action: ComponentAction;
  created?: boolean;
  nodeId?: string;
  error?: string;
}

export interface SyncResult {
  /** Fatal error — the run stopped before components (or at all). */
  aborted?: string;
  dryRun: boolean;
  tokens: {
    primitives: Counts;
    semantic: Counts;
    textStyles: number;
    effectStyles: number;
  };
  components: ComponentOutcome[];
}

interface Counts {
  planned: number;
  upserted: number;
  unchanged: number;
}

/**
 * The whole pipeline, in order: tokens (primitives → semantic → styles),
 * dependency graph, components in topological chunks with the manifest written
 * after every chunk. One failed component does not stop the run; its
 * dependents are skipped. A failed token phase aborts before any component —
 * component specs reference variables by name.
 */
export async function runSync(options: SyncOptions): Promise<SyncResult> {
  const { config } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const chunkSize = options.chunkSize ?? config.chunkSize;
  const force = options.force ?? false;
  const dryRun = options.client === null;

  const { plan, index } = planTokens(config.tokensFile, config);

  // ---- Tokens ------------------------------------------------------------
  let manifest: Manifest = dryRun ? { version: 1, components: {}, tokens: {} } : loadManifest(config.manifestFile);
  const tokenStats = await syncTokens(plan, manifest, options.client, force, dryRun, log);
  if (tokenStats.aborted) {
    // Keep whatever synced before the failure — resume is the whole point.
    if (!dryRun) saveManifest(config.manifestFile, tokenStats.manifest);
    return { aborted: tokenStats.aborted, dryRun, tokens: tokenStats.counts, components: [] };
  }
  manifest = tokenStats.manifest;
  if (!dryRun) saveManifest(config.manifestFile, manifest);

  // ---- Components --------------------------------------------------------
  const planned = planComponents(config, index, options.only);

  if (!dryRun) {
    for (const component of planned) {
      const entry = manifest.components[component.parsed.codeKey];
      if (entry && entry.status !== "synced") entry.status = "pending";
    }
    saveManifest(config.manifestFile, manifest);
  }

  const outcomes = new Map<string, ComponentOutcome>();
  const mutable = [...planned];

  for (let offset = 0; offset < mutable.length; offset += chunkSize) {
    const chunk = mutable.slice(offset, offset + chunkSize);

    for (const component of chunk) {
      outcomes.set(component.parsed.codeKey, await processComponent(component, outcomes, {
        client: options.client,
        manifest,
        force,
        dryRun,
        log,
      }));
    }

    if (!dryRun) saveManifest(config.manifestFile, manifest);
    const done = Math.min(offset + chunkSize, mutable.length);
    log(`  · manifest written (${done}/${mutable.length})`);
  }

  return {
    dryRun,
    tokens: tokenStats.counts,
    components: [...outcomes.values()],
  };
}

// ---------------------------------------------------------------------------
// Tokens phase
// ---------------------------------------------------------------------------

export interface TokenPhase {
  counts: SyncResult["tokens"];
  manifest: Manifest;
  aborted?: string;
}

/**
 * Narrow a token sync to the variables/styles a watcher already knows changed.
 * Style keys are `text:<key>` and `effect:<key>`; omitting `styles` syncs all
 * styles (the batch CLI's normal behavior).
 */
export interface TokenSyncFilter {
  variables?: ReadonlySet<string>;
  styles?: ReadonlySet<string>;
}

export async function syncTokens(
  plan: TokensPlan,
  manifest: Manifest,
  client: BridgeCaller | null,
  force: boolean,
  dryRun: boolean,
  log: (line: string) => void,
  filter?: TokenSyncFilter,
): Promise<TokenPhase> {
  const textStyles = filter?.styles
    ? plan.textStyles.filter((style) => filter.styles?.has(`text:${style.key}`))
    : plan.textStyles;
  const effectStyles = filter?.styles
    ? plan.effectStyles.filter((style) => filter.styles?.has(`effect:${style.key}`))
    : plan.effectStyles;
  const counts: SyncResult["tokens"] = {
    primitives: { planned: plan.primitives.variables.length, upserted: 0, unchanged: 0 },
    semantic: { planned: 0, upserted: 0, unchanged: 0 },
    textStyles: textStyles.length,
    effectStyles: effectStyles.length,
  };
  for (const entry of plan.semanticCollections ?? [plan.semantic]) counts.semantic.planned += entry.variables.length;

  const sections = buildTokenSections(plan);
  log(
    `tokens: ${counts.primitives.planned} primitives, ${counts.semantic.planned} semantic, ` +
      `${counts.textStyles} text styles, ${counts.effectStyles} effect styles`,
  );

  for (const section of sections) {
    const changed = section.variables.filter((variable) => {
      if (filter?.variables && !filter.variables.has(variable.codeKey)) return false;
      const known = manifest.tokens[variable.codeKey];
      return force || !known || known.valueHash !== hashSpec(variable);
    });
    const bucket = section.bucket === "primitives" ? counts.primitives : counts.semantic;
    bucket.unchanged += section.variables.length - changed.length;

    if (changed.length === 0) {
      log(`  ${section.collection}: no changes`);
      continue;
    }
    if (dryRun) {
      bucket.upserted += changed.length;
      log(`  ${section.collection}: would upsert ${changed.length} variable(s)`);
      continue;
    }

    try {
      const collection = await (client as BridgeCaller).call<{ collection: { id: string; modes: { modeId: string; name: string }[] } }>(
        "create_collection",
        { name: section.collection, modes: section.modes },
      );
      const response = await (client as BridgeCaller).call<{
        variables: { id: string; name: string; action: string }[];
        errors: { name: string; message: string }[];
      }>("upsert_variables", {
        collection: section.collection,
        variables: changed.map((variable) => ({
          name: variable.name,
          type: variable.type,
          codeKey: variable.codeKey,
          scopes: variable.scopes,
          values: variable.values,
        })),
        defaultMode: section.defaultMode,
      });

      let confirmed = 0;
      for (const variable of changed) {
        const stored = response.variables.find(entry => entry.name === variable.name);
        if (!stored || response.errors.some(error => error.name === variable.name)) continue;
        manifest.tokens[variable.codeKey] = { ...manifest.tokens[variable.codeKey], figmaVariableId: stored.id, valueHash: hashSpec(variable) };
        confirmed += 1;
      }
      bucket.upserted += confirmed;
      if (response.errors.length > 0) {
        return {
          counts,
          manifest,
          aborted:
            `Figma refused ${response.errors.length} variable(s) in "${section.collection}": ` +
            response.errors.map((error) => `${error.name}: ${error.message}`).join("; ") +
            ". Components were not attempted.",
        };
      }

      if (confirmed !== changed.length) return { counts, manifest, aborted: "Figma did not confirm every variable write. Review a fresh plan before retrying." };
      log(`  ${section.collection}: ${changed.length} variable(s) upserted (${collection.collection.id})`);
    } catch (error) {
      return { counts, manifest, aborted: describeCallError(error, "tokens") };
    }
  }

  // Styles re-upsert every run: they are not part of the v1 manifest, and
  // upserts are idempotent (matched by codeKey, then name).
  if (!dryRun && (textStyles.length > 0 || effectStyles.length > 0)) {
    try {
      for (const style of textStyles) {
        await (client as BridgeCaller).call("upsert_text_style", style.params);
      }
      for (const style of effectStyles) {
        await (client as BridgeCaller).call("upsert_effect_style", style.params);
      }
    } catch (error) {
      return { counts, manifest, aborted: describeCallError(error, "styles") };
    }
  }

  return { counts, manifest };
}

interface TokenSection {
  bucket: "primitives" | "semantic";
  collection: string;
  modes: string[];
  defaultMode: string;
  variables: TokensPlan["primitives"]["variables"];
}

/** Union of all sections for both mode strategies. */
function buildTokenSections(plan: TokensPlan): TokenSection[] {
  if (plan.semanticCollections) {
    return [
      {
        bucket: "primitives",
        collection: plan.primitives.collection,
        modes: plan.primitives.modes,
        defaultMode: plan.primitives.modes[0],
        variables: plan.primitives.variables,
      },
      ...plan.semanticCollections.map((entry) => ({
        bucket: "semantic" as const,
        collection: entry.collection,
        modes: ["Value"],
        defaultMode: "Value",
        variables: entry.variables,
      })),
    ];
  }

  return [
    {
      bucket: "primitives",
      collection: plan.primitives.collection,
      modes: plan.primitives.modes,
      defaultMode: plan.primitives.modes[0],
      variables: plan.primitives.variables,
    },
    {
      bucket: "semantic",
      collection: plan.semantic.collection,
      modes: plan.semantic.modes,
      defaultMode: plan.semantic.modes[0],
      variables: plan.semantic.variables,
    },
  ];
}

// ---------------------------------------------------------------------------
// Components phase
// ---------------------------------------------------------------------------

/**
 * The specHash batch records for a component — the code-side half of the
 * manifest. elf imports this so both sides always agree on what the hash
 * covers. A sidecar that fails validation counts as null, exactly as a
 * failed sync records it.
 */
export function componentSourceHash(componentsDir: string, parsed: ParsedComponent): string {
  return hashSpec(readFileSync(resolve(componentsDir, parsed.file), "utf8"));
}

export function componentSpecHash(componentsDir: string, parsed: ParsedComponent): string {
  let sidecar: SidecarSpec | null = null;
  try {
    const loaded = loadSidecar(componentsDir, parsed);
    if (loaded !== null) sidecar = validateSidecar(loaded, sidecarPathFor(componentsDir, parsed));
  } catch {
    sidecar = null;
  }
  return hashSpec({ parsed: specOf(parsed), sidecar });
}

/** Parses, validates sidecars, orders by dependency, applies --only. */
export function planComponents(config: BatchConfig, index: TokenIndex, only?: string): PlannedComponent[] {
  const parsed = parseComponents(config.componentsDir, config.componentFiles);
  if (parsed.length === 0) {
    throw new Error(
      `No components found in ${config.componentsDir} (looked for ${COMPONENT_EXTENSIONS.join(", ")}).`,
    );
  }

  let selected = parsed;
  if (only !== undefined) {
    const match = parsed.find((component) => component.name === only || component.codeKey === only);
    if (!match) {
      const known = parsed.map((component) => component.name).join(", ");
      throw new Error(`No component matches "--only ${only}". Known components: ${known}.`);
    }
    selected = withDependencies(parsed, match);
  }

  const ordered = orderComponents(selected);
  return ordered.map((component) => planComponent(config, index, component));
}

function withDependencies(all: ParsedComponent[], root: ParsedComponent): ParsedComponent[] {
  const byKey = new Map(all.map((component) => [component.codeKey, component]));
  const picked = new Map<string, ParsedComponent>();
  const visit = (component: ParsedComponent): void => {
    if (picked.has(component.codeKey)) return;
    picked.set(component.codeKey, component);
    for (const dependency of component.dependencies) {
      const dep = byKey.get(dependency);
      if (dep) visit(dep);
    }
  };
  visit(root);
  return [...picked.values()];
}

export function planComponent(config: BatchConfig, index: TokenIndex, parsed: ParsedComponent): PlannedComponent {
  const variants = variantMatrix(parsed);
  const planned: PlannedComponent = { parsed, sidecar: null, variants, sourceHash: componentSourceHash(config.componentsDir, parsed) };
  const sidecarPath = sidecarPathFor(config.componentsDir, parsed);

  let sidecar: SidecarSpec | null;
  try {
    sidecar = loadSidecar(config.componentsDir, parsed);
  } catch (error) {
    planned.sidecarError = (error as Error).message;
    return planned;
  }
  if (sidecar === null) {
    planned.sidecarError = `Missing sidecar: expected ${sidecarPath}. Every component needs one.`;
    return planned;
  }

  try {
    const validated = validateSidecar(sidecar, sidecarPath);
    planned.sidecar = validated;
    const { shared, perVariant } = resolveSidecar(validated, variants, index, sidecarPath);

    if (variants.length === 0) {
      if (Object.keys(perVariant).length > 0) {
        throw new Error(`${sidecarPath}: "variants" overrides given, but ${parsed.name} has no variant props.`);
      }
      planned.params = { name: parsed.name, codeKey: parsed.codeKey, ...shared };
    } else {
      planned.setParams = { name: parsed.name, codeKey: parsed.codeKey, ...shared };
      planned.variantParams = perVariant;
    }
  } catch (error) {
    planned.sidecarError = (error as Error).message;
  }

  return planned;
}

/** The cartesian product of every string-literal-union prop, in declaration order. */
export function variantMatrix(parsed: ParsedComponent): Variant[] {
  let combos: Record<string, string>[] = [{}];
  for (const prop of parsed.variantProps) {
    if (combos.length * prop.values.length > 256) throw new Error(`${parsed.name} has more than 256 variants. Narrow the supported variant props before syncing.`);
    combos = combos.flatMap((combo) => prop.values.map((value) => ({ ...combo, [prop.name]: value })));
  }
  if (parsed.variantProps.length === 0) return [];

  const keys = parsed.variantProps.map((prop) => prop.name);
  return combos.map((props) => ({
    props,
    label: keys.map((key) => `${key}=${props[key]}`).join(", "),
  }));
}

export async function processComponent(
  component: PlannedComponent,
  outcomes: Map<string, ComponentOutcome>,
  context: {
    client: BridgeCaller | null;
    manifest: Manifest;
    force: boolean;
    dryRun: boolean;
    log: (line: string) => void;
  },
): Promise<ComponentOutcome> {
  const { parsed, variants } = component;
  const base: ComponentOutcome = { name: parsed.name, codeKey: parsed.codeKey, file: parsed.file, action: "pending" };

  // A failed or skipped dependency poisons everything downstream.
  const blocked = parsed.dependencies
    .map((dependency) => outcomes.get(dependency))
    .find((outcome) => outcome && (outcome.action === "failed" || outcome.action === "skipped"));
  if (blocked) {
    base.action = "skipped";
    base.error = `Depends on ${blocked.name} (${blocked.action})${blocked.error ? `: ${blocked.error}` : ""}.`;
    context.log(`✗ ${parsed.file} — skipped (dependency ${blocked.name} ${blocked.action})`);
    if (!context.dryRun) {
      context.manifest.components[parsed.codeKey] = {
        figmaNodeId: context.manifest.components[parsed.codeKey]?.figmaNodeId ?? null,
        specHash: hashSpec({ parsed: specOf(parsed), sidecar: component.sidecar }),
        ...keptNodeHash(context.manifest.components[parsed.codeKey]),
        status: "skipped",
        updatedAt: new Date().toISOString(),
        error: base.error,
      };
    }
    return base;
  }

  const specHash = hashSpec({ parsed: specOf(parsed), sidecar: component.sidecar });
  const known = context.manifest.components[parsed.codeKey];

  if (!context.force && known && known.status === "synced" && known.specHash === specHash && known.figmaNodeId) {
    base.action = "unchanged";
    base.nodeId = known.figmaNodeId;
    context.log(`• ${parsed.file} — unchanged`);
    return base;
  }

  if (component.sidecarError) {
    base.action = "failed";
    base.error = component.sidecarError;
    context.log(`✗ ${parsed.file} — ${component.sidecarError}`);
    if (!context.dryRun) {
      context.manifest.components[parsed.codeKey] = {
        figmaNodeId: known?.figmaNodeId ?? null,
        specHash,
        ...keptNodeHash(known),
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: base.error,
      };
    }
    return base;
  }

  if (context.dryRun) {
    base.action = "synced";
    context.log(`→ ${parsed.file} — would ${variants.length > 0 ? `sync ${variants.length} variants` : "sync"}`);
    return base;
  }

  try {
    const params = variants.length > 0 ? buildSetParams(component) : (component.params as Record<string, unknown>);
    const result = await (context.client as BridgeCaller).call<{
      component?: { id: string; created: boolean };
      set?: { id: string; created: boolean };
    }>(variants.length > 0 ? "upsert_component_set" : "upsert_component", params);

    const node = result.component ?? result.set;
    if (!node) throw new Error("The bridge answered without a node id.");

    base.action = "synced";
    base.created = node.created;
    base.nodeId = node.id;
    const nodeHash = await readNodeHash(context, node.id, parsed.file);
    context.manifest.components[parsed.codeKey] = {
      figmaNodeId: node.id,
      specHash,
      nodeHash,
      sourceHash: component.sourceHash,
      status: "synced",
      updatedAt: new Date().toISOString(),
    };
    context.log(`✓ ${parsed.file} ${node.created ? "created" : "updated"} (node ${node.id})`);
  } catch (error) {
    base.action = "failed";
    base.error = (error as Error).message;
    context.manifest.components[parsed.codeKey] = {
      figmaNodeId: known?.figmaNodeId ?? null,
      specHash,
      ...keptNodeHash(known),
      status: "failed",
      updatedAt: new Date().toISOString(),
      error: base.error,
    };
    context.log(`✗ ${parsed.file} — ${base.error}`);
  }

  return base;
}

/**
 * Reads the node back right after an upsert so the manifest can carry the
 * state hash elf later compares against. A failed read is not a failed sync:
 * the component is written, the hash is simply unknown until the next run.
 */
async function readNodeHash(
  context: { client: BridgeCaller | null; log: (line: string) => void },
  nodeId: string,
  file: string,
): Promise<string | null> {
  try {
    const state = await (context.client as BridgeCaller).call<{ node: unknown }>("get_node", {
      nodeId,
      depth: NODE_STATE_DEPTH,
    });
    return nodeStateHash(state.node);
  } catch (error) {
    context.log(`  ! ${file} — synced, but reading the node state failed (${(error as Error).message})`);
    return null;
  }
}

/** Keeps an existing nodeHash when a run does not touch the node. */
function keptNodeHash(entry: { nodeHash?: string | null } | undefined): { nodeHash?: string } {
  return entry?.nodeHash ? { nodeHash: entry.nodeHash } : {};
}

function buildSetParams(component: PlannedComponent): Record<string, unknown> {
  return {
    ...component.setParams,
    variants: component.variants.map((variant) => ({
      props: variant.props,
      ...(component.variantParams?.[variant.label] ? { spec: component.variantParams[variant.label] } : {}),
    })),
  };
}

/** The parser output, without bookkeeping — the part the specHash covers. */
function specOf(parsed: ParsedComponent): Record<string, unknown> {
  return {
    name: parsed.name,
    codeKey: parsed.codeKey,
    file: parsed.file,
    variantProps: parsed.variantProps,
    dependencies: parsed.dependencies,
  };
}

function describeCallError(error: unknown, phase: string): string {
  const message = (error as Error).message ?? String(error);
  return `Bridge call failed during ${phase}: ${message}`;
}
