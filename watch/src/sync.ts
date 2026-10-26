import {
  componentSpecHash,
  planComponent,
  processComponent,
  syncTokens,
  type ComponentOutcome,
} from "../../batch/src/sync.js";
import { orderComponents } from "../../batch/src/graph.js";
import { hashSpec, loadManifest, saveManifest } from "../../batch/src/manifest.js";
import { NODE_STATE_DEPTH, nodeStateHash } from "../../batch/src/nodestate.js";
import { parseComponents } from "../../batch/src/parser.js";
import { planTokens, type TokenIndex } from "../../batch/src/tokens.js";
import type {
  BatchConfig,
  Manifest,
  ParsedComponent,
  PlannedComponent,
  PlannedVariable,
  TokensPlan,
} from "../../batch/src/types.js";
import type { Log, SyncSummary, WatchBridge } from "./types.js";

export interface SyncChangesOptions {
  config: BatchConfig;
  bridge: WatchBridge;
  tokensChanged: boolean;
  /** Mutable: names/codeKeys are removed after a forced sync. */
  forceComponents?: Set<string>;
  log?: Log;
  /** Checked between chunks; the current chunk always finishes. */
  stopping?: () => boolean;
}

interface SelectedComponent {
  parsed: ParsedComponent;
  planned: PlannedComponent;
}

/**
 * Push only what changed: changed tokens, changed components, and components
 * that depend on them. Every conflict is checked against the manifest's
 * nodeHash before the component is touched. The manifest is saved after each
 * chunk, so a Ctrl+C never loses completed work.
 */
export async function syncChanges(options: SyncChangesOptions): Promise<SyncSummary> {
  const { config, bridge } = options;
  const log = options.log ?? (() => {});
  const force = options.forceComponents ?? new Set<string>();
  const stopping = options.stopping ?? (() => false);
  const manifest = loadManifest(config.manifestFile);
  const { plan, index } = planTokens(config.tokensFile, config);

  const summary: SyncSummary = {
    components: 0,
    tokens: 0,
    styles: 0,
    conflicts: [],
    skipped: [],
    failed: [],
    failures: [],
  };

  const tokensChanged = options.tokensChanged || Object.keys(manifest.tokens).length === 0;
  if (tokensChanged) {
    const changedKeys = changedTokenKeys(plan, manifest);
    const tokenResult = await syncTokens(
      plan,
      manifest,
      bridge,
      false,
      false,
      log,
      { variables: changedKeys, styles: undefined },
    );
    if (tokenResult.aborted) {
      saveManifest(config.manifestFile, manifest);
      throw new Error(tokenResult.aborted);
    }
    summary.tokens = tokenResult.counts.primitives.upserted + tokenResult.counts.semantic.upserted;
    summary.styles = tokenResult.counts.textStyles + tokenResult.counts.effectStyles;
    saveManifest(config.manifestFile, manifest);
  }

  const selected = selectComponents(config, index, manifest, force);
  if (selected.length === 0) return summary;

  const { selected: complete, repair } = await includeMissingDependencies(
    selected,
    config,
    index,
    manifest,
    bridge,
  );
  const ordered = orderComponents(complete.map((entry) => entry.parsed));
  const byKey = new Map(complete.map((entry) => [entry.parsed.codeKey, entry]));
  const outcomes = new Map<string, ComponentOutcome>();
  const chunkSize = config.chunkSize;
  let stopped = false;

  for (let offset = 0; offset < ordered.length; offset += chunkSize) {
    if (stopping()) {
      stopped = true;
      break;
    }
    const chunk = ordered.slice(offset, offset + chunkSize);
    for (const parsed of chunk) {
      const entry = byKey.get(parsed.codeKey) as SelectedComponent;
      const known = manifest.components[parsed.codeKey];
      const repairing = repair.has(parsed.codeKey);
      const forced = repairing || force.has(parsed.name) || force.has(parsed.codeKey);

      if (!forced) {
        const conflict = await conflictFor(bridge, known);
        if (conflict?.kind === "changed") {
          summary.conflicts.push(parsed.name);
          summary.skipped.push(parsed.name);
          outcomes.set(parsed.codeKey, {
            name: parsed.name,
            codeKey: parsed.codeKey,
            file: parsed.file,
            action: "skipped",
            error: conflict.message,
          });
          log(`! ${parsed.name} — ${conflict.message}; skipping (use --force-component ${parsed.name} to override)`);
          continue;
        }
        if (conflict?.kind === "missing") {
          log(`! ${parsed.name} — ${conflict.message}; re-creating`);
        }
      } else if (repairing) {
        log(`! ${parsed.name} — missing in Figma; re-creating as a dependency`);
      } else {
        log(`! ${parsed.name} — forcing past Figma-change check`);
      }

      const outcome = await processComponent(entry.planned, outcomes, {
        client: bridge,
        manifest,
        force: true,
        dryRun: false,
        log,
      });
      outcomes.set(parsed.codeKey, outcome);
      if (outcome.action === "synced") summary.components += 1;
      if (outcome.action === "failed") {
        summary.failed.push(parsed.name);
        summary.failures.push({ name: parsed.name, error: outcome.error ?? "unknown error" });
      }
      if (outcome.action === "skipped") summary.skipped.push(parsed.name);
      if (forced) {
        force.delete(parsed.name);
        force.delete(parsed.codeKey);
      }
    }
    saveManifest(config.manifestFile, manifest);
  }

  if (stopped) summary.aborted = "Stopped before the next chunk.";
  return summary;
}

/**
 * Changed components are those whose sidecar/code specHash differs from the
 * manifest, plus anything that failed or was skipped. Dependencies that are
 * missing from Figma are pulled in first, and dependents are pulled in
 * transitively, so instances never point at a component that does not exist.
 */
function selectComponents(
  config: BatchConfig,
  index: TokenIndex,
  manifest: Manifest,
  force: Set<string>,
): SelectedComponent[] {
  const parsed = parseComponents(config.componentsDir, config.componentFiles);
  if (parsed.length === 0) return [];

  const byKey = new Map(parsed.map((component) => [component.codeKey, component]));
  const changed = new Set<string>();
  const missingInFigma = (codeKey: string): boolean => {
    const known = manifest.components[codeKey];
    return !known || known.status !== "synced" || !known.figmaNodeId;
  };

  for (const component of parsed) {
    const known = manifest.components[component.codeKey];
    if (
      force.has(component.name) ||
      force.has(component.codeKey) ||
      missingInFigma(component.codeKey) ||
      known?.specHash !== componentSpecHash(config.componentsDir, component)
    ) {
      changed.add(component.codeKey);
    }
  }

  const dependents = new Map<string, string[]>();
  for (const component of parsed) {
    for (const dependency of component.dependencies) {
      if (!byKey.has(dependency)) continue;
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), component.codeKey]);
    }
  }

  const queue = [...changed];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    const component = byKey.get(key);
    for (const dependency of component?.dependencies ?? []) {
      if (!byKey.has(dependency) || !missingInFigma(dependency) || changed.has(dependency)) continue;
      changed.add(dependency);
      queue.push(dependency);
    }
    for (const dependent of dependents.get(key) ?? []) {
      if (changed.has(dependent)) continue;
      changed.add(dependent);
      queue.push(dependent);
    }
  }

  return [...changed]
    .map((key) => byKey.get(key))
    .filter((component): component is ParsedComponent => component !== undefined)
    .map((component) => ({
      parsed: component,
      planned: planComponent(config, index, component),
    }));
}

/**
 * A component can reference a dependency that the manifest says is synced,
 * but whose Figma node was deleted or belongs to another file. Check the
 * actual node (and its codeKey) before syncing the dependent; repair missing
 * dependencies in the same run, in dependency order.
 */
async function includeMissingDependencies(
  selected: SelectedComponent[],
  config: BatchConfig,
  index: TokenIndex,
  manifest: Manifest,
  bridge: WatchBridge,
): Promise<{ selected: SelectedComponent[]; repair: Set<string> }> {
  const parsedByKey = new Map(
    parseComponents(config.componentsDir, config.componentFiles).map((component) => [component.codeKey, component]),
  );
  const byKey = new Map(selected.map((entry) => [entry.parsed.codeKey, entry]));
  const result = [...selected];
  const repair = new Set<string>();
  const exists = new Map<string, boolean>();

  const existsInFigma = async (codeKey: string): Promise<boolean> => {
    const cached = exists.get(codeKey);
    if (cached !== undefined) return cached;
    const known = manifest.components[codeKey];
    if (!known?.figmaNodeId) {
      exists.set(codeKey, false);
      return false;
    }
    try {
      const { node } = await bridge.call<{ node: { codeKey?: string | null } }>("get_node", {
        nodeId: known.figmaNodeId,
        depth: 0,
      });
      const found = node.codeKey === codeKey;
      exists.set(codeKey, found);
      return found;
    } catch (error) {
      if (/not found/i.test((error as Error).message)) {
        exists.set(codeKey, false);
        return false;
      }
      throw error;
    }
  };

  const queue = [...selected];
  while (queue.length > 0) {
    const entry = queue.shift() as SelectedComponent;
    for (const dependency of entry.parsed.dependencies) {
      if (byKey.has(dependency)) continue;
      const parsed = parsedByKey.get(dependency);
      if (!parsed || (await existsInFigma(dependency))) continue;
      const added = { parsed, planned: planComponent(config, index, parsed) };
      byKey.set(dependency, added);
      result.push(added);
      repair.add(dependency);
      queue.push(added);
    }
  }

  return { selected: result, repair };
}

type Conflict = { kind: "changed" | "missing"; message: string };

async function conflictFor(
  bridge: WatchBridge,
  known: Manifest["components"][string] | undefined,
): Promise<Conflict | null> {
  if (!known?.figmaNodeId || !known.nodeHash) return null;
  try {
    const { node } = await bridge.call<{ node: unknown }>("get_node", {
      nodeId: known.figmaNodeId,
      depth: NODE_STATE_DEPTH,
    });
    if (nodeStateHash(node) === known.nodeHash) return null;
    return { kind: "changed", message: `Figma changed since the last push (node ${known.figmaNodeId})` };
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (/not found/i.test(message)) {
      return { kind: "missing", message: `Figma node ${known.figmaNodeId} no longer exists` };
    }
    throw error;
  }
}

function changedTokenKeys(plan: TokensPlan, manifest: Manifest): Set<string> {
  const changed = new Set<string>();
  for (const section of tokenSections(plan)) {
    for (const variable of section.variables) {
      const known = manifest.tokens[variable.codeKey];
      if (!known || known.valueHash !== hashSpec(variable)) changed.add(variable.codeKey);
    }
  }
  return changed;
}

function tokenSections(plan: TokensPlan): { variables: PlannedVariable[] }[] {
  return [plan.primitives, plan.semantic, ...(plan.semanticCollections ?? [])];
}
