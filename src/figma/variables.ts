import { categoryFromName, rgbToHex, slugify } from "../normalize.js";
import type { Token } from "../types.js";
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
  modes: { modeId: string; name: string }[];
}

interface VariablesResponse {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, VariableCollection>;
  };
}

export async function fetchVariables(
  api: FigmaApi,
  fileKey: string,
  modeName?: string | null,
): Promise<Token[]> {
  const { meta } = await api.get<VariablesResponse>(`/files/${fileKey}/variables/local`);
  const variables = Object.values(meta.variables);
  if (variables.length === 0) return [];

  const resolveModeId = (variable: FigmaVariable): string | undefined => {
    const collection = meta.variableCollections[variable.variableCollectionId];
    if (!collection || collection.modes.length === 0) return undefined;
    if (modeName) {
      return collection.modes.find((mode) => mode.name === modeName)?.modeId ?? collection.modes[0].modeId;
    }
    return collection.modes[0].modeId;
  };

  const resolveValue = (
    variable: FigmaVariable,
    modeId: string,
    seen: Set<string> = new Set(),
  ): unknown => {
    const entry = variable.valuesByMode[modeId];
    if (!entry) return undefined;
    if (entry.type !== "VARIABLE_ALIAS") return entry.value;
    if (seen.has(String(entry.value))) return undefined;
    const target = meta.variables[String(entry.value)];
    if (!target) return undefined;
    return resolveValue(target, modeId, new Set([...seen, String(entry.value)]));
  };

  const tokens: Token[] = [];
  const skipped: string[] = [];

  for (const variable of variables) {
    const name = slugify(variable.name);
    const modeId = resolveModeId(variable);
    if (!modeId) {
      skipped.push(name);
      continue;
    }
    const token = toToken(variable.resolvedType, name, resolveValue(variable, modeId));
    if (token) tokens.push(token);
    else skipped.push(name);
  }

  if (skipped.length > 0) {
    console.warn(`Skipped ${skipped.length} variable(s) (unsupported type or category): ${skipped.join(", ")}`);
  }

  return tokens;
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
    if (category === "other") return null;
    const numeric = typeof value === "number" ? `${value}px` : String(value);
    return { name, category, value: numeric, source: "figma" };
  }

  return null;
}
