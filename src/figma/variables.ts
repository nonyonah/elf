import { categoryFromName, rgbToHex, slugify } from "../core/normalize.js";
import type { ModeName, ModeStrategy, Token } from "../core/types.js";
import type { FigmaApi } from "./client.js";

interface FigmaColorValue {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface FigmaVariable {
  id: string;
  name: string;
  key: string;
  variableCollectionId: string;
  resolvedType: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  valuesByMode: Record<string, { type: string; value: unknown }>;
}

interface VariableCollection {
  id: string;
  name: string;
  defaultModeId?: string;
  modes: { modeId: string; name: string }[];
}

/** What both the REST and the bridge fetchers need from a collection. */
export interface CollectionLike {
  name: string;
  defaultModeId?: string;
  modes: { modeId: string; name: string }[];
}

interface VariablesResponse {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, VariableCollection>;
  };
}

export interface FetchVariablesOptions {
  /** null = first mode of each collection; "all" or a list = multi-mode. */
  modeName?: ModeName;
  /** "collections" treats every collection as one mode, named after it. */
  modeStrategy?: ModeStrategy;
}

/** One mode to read for a variable, plus what to label the resulting token. */
export interface ModeSelection {
  modeId: string;
  /** Set when the user asked for all/named modes — the label under comparison. */
  label?: string;
  /** The mode's own name, used to line up cross-collection aliases. */
  modeName?: string;
  /** Collection-strategy hint: the collection's name. */
  hint?: string;
}

export async function fetchVariables(
  api: FigmaApi,
  fileKey: string,
  options: FetchVariablesOptions = {},
): Promise<Token[]> {
  const { meta } = await api.get<VariablesResponse>(`/files/${fileKey}/variables/local`);
  const variables = Object.values(meta.variables);
  if (variables.length === 0) return [];

  const labelled = isMulti(options.modeName);
  const tokens: Token[] = [];
  const skipped: string[] = [];

  for (const variable of variables) {
    const name = slugify(variable.name);
    const collection = meta.variableCollections[variable.variableCollectionId];
    if (!collection || collection.modes.length === 0) {
      skipped.push(name);
      continue;
    }

    for (const selection of selectModes(collection, options)) {
      const value = resolveValue(meta, variable, selection, new Set());
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
    console.warn(`Skipped ${skipped.length} variable(s) (unsupported type or category): ${skipped.join(", ")}`);
  }

  return tokens;
}

export function isMulti(modeName: ModeName | undefined): boolean {
  return modeName === "all" || Array.isArray(modeName);
}

/** Which modes of this variable's collection take part in the comparison. */
export function selectModes(collection: CollectionLike, options: FetchVariablesOptions): ModeSelection[] {
  const { modeName = null, modeStrategy = "modes" } = options;
  const first = collection.modes[0];

  if (modeStrategy === "collections") {
    // Every collection is one mode, named after the collection.
    const wanted = modeName === null || modeName === "all" ? null : asList(modeName);
    if (wanted && !wanted.some((name) => name === collection.name)) return [];
    const labelled = modeName === "all" || Array.isArray(modeName);
    return [
      {
        modeId: first.modeId,
        modeName: first.name,
        hint: collection.name,
        ...(labelled ? { label: collection.name } : {}),
      },
    ];
  }

  if (modeName === null) {
    return [{ modeId: first.modeId, modeName: first.name }];
  }
  if (modeName === "all") {
    return collection.modes.map((mode) => ({ modeId: mode.modeId, modeName: mode.name, label: mode.name }));
  }

  const wanted = asList(modeName);
  const matches = collection.modes.filter((mode) => wanted.includes(mode.name));
  // Legacy single-name behavior: an unknown mode falls back to the first one.
  if (matches.length === 0) return [{ modeId: first.modeId, modeName: first.name }];
  const labelled = Array.isArray(modeName);
  return matches.map((mode) => ({
    modeId: mode.modeId,
    modeName: mode.name,
    ...(labelled ? { label: mode.name } : {}),
  }));
}

function asList(modeName: string | string[]): string[] {
  return Array.isArray(modeName) ? modeName : [modeName];
}

/**
 * Follows VARIABLE_ALIAS chains to a literal. Cross-collection aliases line
 * up by mode name (the same rule Figma uses); when the consuming side has no
 * usable name, the target collection's default mode is used.
 */
function resolveValue(
  meta: VariablesResponse["meta"],
  variable: FigmaVariable,
  selection: ModeSelection,
  seen: Set<string>,
): unknown {
  const entry = variable.valuesByMode[selection.modeId];
  if (!entry) return undefined;
  if (entry.type !== "VARIABLE_ALIAS") return entry.value;

  const targetId = String(entry.value);
  if (seen.has(targetId)) return undefined;
  const target = meta.variables[targetId];
  if (!target) return undefined;

  const collection = meta.variableCollections[target.variableCollectionId];
  const modeId = pickTargetMode(collection, selection);
  if (!modeId) return undefined;

  return resolveValue(
    meta,
    target,
    { modeId, modeName: collection?.modes.find((mode) => mode.modeId === modeId)?.name, hint: selection.hint },
    new Set([...seen, targetId]),
  );
}

export function pickTargetMode(collection: CollectionLike | undefined, selection: ModeSelection): string | undefined {
  if (!collection || collection.modes.length === 0) return undefined;
  if (selection.modeName) {
    const match = collection.modes.find((mode) => mode.name === selection.modeName);
    if (match) return match.modeId;
  }
  if (selection.hint) {
    const lower = selection.hint.toLowerCase();
    const match = collection.modes.find((mode) => lower.includes(mode.name.toLowerCase()));
    if (match) return match.modeId;
  }
  return collection.defaultModeId ?? collection.modes[0]?.modeId;
}

function toToken(resolvedType: string, name: string, value: unknown): Token | null {
  if (value === undefined || value === null) return null;

  if (resolvedType === "COLOR") {
    const { r, g, b, a = 1 } = value as FigmaColorValue;
    return { name, category: "color", value: rgbToHex(r, g, b, a), source: "figma" };
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
