import { loadManifest } from "../batch/src/manifest.js";
import { parseComponents } from "../batch/src/parser.js";
import { componentSourceHash, componentSpecHash } from "../batch/src/sync.js";
import type { BridgeCaller } from "./figma/bridge.js";
import { listBridgeComponents, readNodeState } from "./figma/bridge.js";
import type { ComponentIssue } from "./core/diff.js";

export interface ComponentDiff {
  /** Code changed since the last sync — re-run elf-batch. */
  outOfDate: ComponentIssue[];
  /** The Figma node no longer matches what was last pushed. */
  changedInFigma: ComponentIssue[];
  /** In code with no (reachable) Figma node. */
  inCodeNotInFigma: ComponentIssue[];
  /** Carries an elf codeKey but has no component file anymore. */
  inFigmaNotInCode: ComponentIssue[];
  /** Component names/codeKeys present in code — deprecation bookkeeping. */
  codeComponents: { name: string; codeKey: string; deprecated?: string }[];
  /** codeKeys of components seen in Figma — deprecation bookkeeping. */
  figmaCodeKeys: Set<string>;
}

/**
 * The component half of the drift check. The manifest is the map between
 * code (specHash) and Figma (nodeHash): a specHash mismatch means the code
 * moved on, a nodeHash mismatch means the node did — the two are reported
 * separately. Uses elf-batch's parser and hashing, never a copy.
 */
export async function diffComponents(
  componentsDir: string,
  manifestPath: string,
  client: BridgeCaller,
): Promise<ComponentDiff> {
  const parsed = parseComponents(componentsDir);
  const manifest = loadManifest(manifestPath);
  const figmaComponents = await listBridgeComponents(client);

  const figmaCodeKeys = new Set(
    figmaComponents.map((component) => component.codeKey).filter((key): key is string => Boolean(key)),
  );
  const parsedKeys = new Set(parsed.map((component) => component.codeKey));

  const outOfDate: ComponentIssue[] = [];
  const changedInFigma: ComponentIssue[] = [];
  const inCodeNotInFigma: ComponentIssue[] = [];

  for (const component of parsed) {
    const entry = manifest.components[component.codeKey];
    const base: ComponentIssue = {
      codeHash: componentSourceHash(componentsDir, component),
      name: component.name,
      codeKey: component.codeKey,
      file: component.file,
      ...(entry?.figmaNodeId ? { nodeId: entry.figmaNodeId } : {}),
    };

    const knownInFigma = Boolean(entry?.figmaNodeId) || figmaCodeKeys.has(component.codeKey);
    if (!knownInFigma) {
      inCodeNotInFigma.push({
        ...base,
        detail: entry?.error ?? "never synced by elf-batch",
      });
      continue;
    }

    const implementationChanged = entry?.sourceHash && entry.sourceHash !== componentSourceHash(componentsDir, component);
    const specChanged =
      entry === undefined || entry.specHash !== componentSpecHash(componentsDir, component);

    let figmaChanged = false;
    let figmaDetail: string | undefined;
    if (entry?.figmaNodeId && entry.nodeHash) {
      const state = await readNodeState(client, entry.figmaNodeId);
      if (!state.found) {
        figmaChanged = true;
        figmaDetail = "the Figma node no longer exists";
      } else if (state.nodeHash !== entry.nodeHash) {
        base.figmaHash = state.nodeHash ?? undefined;
        figmaChanged = true;
        figmaDetail = "the Figma node changed since the last sync";
      }
    }

    if (figmaChanged) {
      changedInFigma.push({
        ...base,
        detail: specChanged ? `${figmaDetail} — and the code spec also changed` : figmaDetail,
      });
    } else if (specChanged || implementationChanged) {
      outOfDate.push({
        ...base,
        detail:
          implementationChanged && !specChanged
            ? "implementation changed; review its Figma description before syncing — visual changes cannot be inferred automatically"
            : entry === undefined
            ? "in Figma but never synced by elf-batch"
            : "the code spec changed — re-run elf-batch",
      });
    }
  }

  const inFigmaNotInCode: ComponentIssue[] = [];
  for (const figma of figmaComponents) {
    if (!figma.codeKey || parsedKeys.has(figma.codeKey)) continue;
    inFigmaNotInCode.push({
      name: figma.name,
      codeKey: figma.codeKey,
      nodeId: figma.id,
      detail: "has an elf codeKey but no matching component file in code",
    });
  }

  return {
    outOfDate,
    changedInFigma,
    inCodeNotInFigma,
    inFigmaNotInCode,
    codeComponents: parsed.map((component) => ({ name: component.name, codeKey: component.codeKey, deprecated: component.deprecated })),
    figmaCodeKeys,
  };
}
