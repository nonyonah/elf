import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_STATE_DEPTH, nodeStateHash } from "../../batch/src/nodestate.js";
import { createBridgeClient } from "../../mcp/src/client.js";
import { loadDotEnvFile } from "../../mcp/src/config.js";
import { categoryFromName, cssColorToHex, slugify } from "../core/normalize.js";
import type { ModeName, ModeStrategy, Token } from "../core/types.js";
import { isMulti, pickTargetMode, selectModes, type ModeSelection } from "./variables.js";

/** The narrow slice of the bridge client elf needs (easy to fake in tests). */
export interface BridgeCaller {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

interface PluginCollection {
  id: string;
  name: string;
  defaultModeId: string;
  modes: { modeId: string; name: string }[];
}

interface PluginVariableModeValue {
  modeId: string;
  type: string;
  value?: unknown;
  id?: string;
  name?: string | null;
}

interface PluginVariable {
  id: string;
  name: string;
  collectionId: string;
  collectionName: string;
  resolvedType: string;
  valuesByMode: Record<string, PluginVariableModeValue>;
}

export interface BridgeFetchOptions {
  modeName?: ModeName;
  modeStrategy?: ModeStrategy;
}

/**
 * Opens a `/control` connection to the bridge, loading `mcp/.env` first so a
 * plain `npm run check-drift` works without exporting anything by hand. Fails
 * with an actionable message instead of a stack trace when the server or the
 * plugin is not there.
 */
export async function connectBridge(fileKey?: string): Promise<BridgeCaller> {
  const here = dirname(fileURLToPath(import.meta.url));
  loadDotEnvFile(resolve(here, "../../mcp/.env"));

  try {
    const client = await createBridgeClient();
    try {
      if (fileKey) await client.call("__elf_lock", { fileKey }, { timeoutMs: 30_000 });
      return client;
    } catch (error) { client.close(); throw error; }
  } catch (error) {
    throw new Error(
      `The Figma bridge is not connected (${(error as Error).message}). ` +
        "Start it with `npm --prefix mcp run start:http` and open the Elf bridge plugin in Figma.",
    );
  }
}

/**
 * Reads variables through the plugin instead of the REST API — works on any
 * Figma plan. Mirrors fetchVariables: the same mode selection, the same
 * cross-collection alias rules, only the transport differs.
 */
export async function fetchBridgeVariables(
  client: BridgeCaller,
  options: BridgeFetchOptions = {},
): Promise<Token[]> {
  const [{ collections }, { variables }] = await Promise.all([
    client.call<{ collections: PluginCollection[] }>("list_collections"),
    client.call<{ variables: PluginVariable[] }>("list_variables"),
  ]);
  if (variables.length === 0) return [];

  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const variableById = new Map(variables.map((variable) => [variable.id, variable]));
  const labelled = isMulti(options.modeName);
  const tokens: Token[] = [];
  const skipped: string[] = [];

  for (const variable of variables) {
    const name = slugify(variable.name);
    const collection = collectionById.get(variable.collectionId);
    if (!collection || collection.modes.length === 0) {
      skipped.push(name);
      continue;
    }

    for (const selection of selectModes(collection, options)) {
      const value = resolveBridgeValue(variableById, collectionById, variable, selection, new Set());
      const token = toToken(variable.resolvedType, name, value);
      if (!token) {
        skipped.push(selection.label ? `${name} (${selection.label})` : name);
        continue;
      }
      if (labelled && selection.label) token.mode = selection.label;
      tokens.push(token);
    }
  }

  if (skipped.length > 0) {
    const detail = process.env.ELF_DEBUG ? `: ${skipped.join(", ")}` : "";
    console.warn(`Skipped ${skipped.length} unsupported Figma variable(s)${detail}.`);
  }

  return tokens;
}

function resolveBridgeValue(
  variableById: Map<string, PluginVariable>,
  collectionById: Map<string, PluginCollection>,
  variable: PluginVariable,
  selection: ModeSelection,
  seen: Set<string>,
): unknown {
  const modeKey = selection.modeName ?? variableModeName(variable, collectionById, selection.modeId);
  const entry = modeKey === null ? undefined : variable.valuesByMode[modeKey];
  if (!entry) return undefined;
  if (entry.type !== "VARIABLE_ALIAS") return entry.value;

  const targetId = entry.id ?? String(entry.value ?? "");
  if (!targetId || seen.has(targetId)) return undefined;
  const target = variableById.get(targetId);
  if (!target) return undefined;

  const targetCollection = collectionById.get(target.collectionId);
  const modeId = pickTargetMode(targetCollection, selection);
  const targetModeKey = targetCollection?.modes.find((mode) => mode.modeId === modeId)?.name;

  return resolveBridgeValue(
    variableById,
    collectionById,
    target,
    { modeId: modeId ?? selection.modeId, modeName: targetModeKey, hint: selection.hint },
    new Set([...seen, targetId]),
  );
}

function variableModeName(
  variable: PluginVariable,
  collectionById: Map<string, PluginCollection>,
  modeId: string,
): string | null {
  const collection = collectionById.get(variable.collectionId);
  return collection?.modes.find((mode) => mode.modeId === modeId)?.name ?? null;
}

/** The plugin hands colors back as hex strings; numbers as plain numbers. */
function toToken(resolvedType: string, name: string, value: unknown): Token | null {
  if (value === undefined || value === null) return null;

  if (resolvedType === "COLOR") {
    const hex = cssColorToHex(String(value));
    return hex ? { name, category: "color", value: hex, source: "figma" } : null;
  }

  if (resolvedType === "STRING") {
    return { name, category: "typography", value: String(value), source: "figma" };
  }

  if (resolvedType === "FLOAT") {
    const category = categoryFromName(name);
    if (category === "other" || category === "shadow") return null;
    const numeric = typeof value === "number" ? `${value}px` : String(value);
    return { name, category, value: numeric, source: "figma" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Component reads — what the component diff in src/components.ts needs
// ---------------------------------------------------------------------------

export interface FigmaComponentRef {
  id: string;
  name: string;
  codeKey: string | null;
}

/** Components in the open file (current page, nested included) with their elf codeKeys. */
export async function listBridgeComponents(client: BridgeCaller): Promise<FigmaComponentRef[]> {
  const { components } = await client.call<{ components: FigmaComponentRef[] }>("list_components", {
    deep: true,
  });
  return components;
}

/**
 * Re-reads a node and hashes its current state the same way elf-batch did at
 * sync time. `found: false` means the node is gone from the file.
 */
export async function readNodeState(
  client: BridgeCaller,
  nodeId: string,
): Promise<{ found: boolean; nodeHash: string | null }> {
  try {
    const { node } = await client.call<{ node: unknown }>("get_node", {
      nodeId,
      depth: NODE_STATE_DEPTH,
    });
    return { found: true, nodeHash: nodeStateHash(node) };
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (/not found/i.test(message)) return { found: false, nodeHash: null };
    throw error;
  }
}
