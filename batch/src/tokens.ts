import { readFileSync } from "node:fs";
import type {
  BatchConfig,
  PlannedEffectStyle,
  PlannedTextStyle,
  PlannedVariable,
  TokensPlan,
} from "./types.js";

/**
 * The batch tokens file:
 *
 *   {
 *     "color":    { "primary": { "500": { "value": "#6366f1", "type": "color" } } },
 *     "space":    { "4": { "value": 16, "type": "dimension" } },
 *     "fontFamily": { "sans": { "value": "Inter", "type": "fontFamilies" } },
 *     "fontSize": { "body": { "value": 14, "type": "fontSizes" } },
 *     "semantic": { "color": { "surface": { "value": "{color.surface.base}",
 *                                            "modes": { "Dark": "{color.surface.raised}" } } } },
 *     "textStyles":   { "Body/Regular": { "fontFamily": "{fontFamily.sans}", "fontSize": "{fontSize.body}" } },
 *     "effectStyles": { "Elevation/1": { "effects": [ … ] } }
 *   }
 *
 * Everything except the three reserved keys is primitives: nested groups whose
 * leaves carry `value` + `type`. Dotted paths become `/`-separated Figma names
 * (`color.primary.500` → `color/primary/500`); the full dotted path is the
 * codeKey. Semantic leaves get their Figma name from the path *after* the
 * `semantic.` prefix, and `{…}` strings (braces optional in sidecars) are
 * aliases resolved by the bridge.
 */

const RESERVED = new Set(["semantic", "textStyles", "effectStyles"]);
const MODE_STRATEGIES = new Set(["modes", "collections"]);

const PRIMITIVE_TYPES: Record<string, PlannedVariable["type"]> = {
  color: "COLOR",
  dimension: "FLOAT",
  fontSizes: "FLOAT",
  fontFamilies: "STRING",
};

const PRIMITIVE_SCOPES: Partial<Record<PlannedVariable["type"], string[]>> = {
  COLOR: ["ALL_FILLS"],
  FLOAT: ["WIDTH_HEIGHT", "GAP", "CORNER_RADIUS"],
  STRING: ["FONT_FAMILY"],
};

export interface TokenIndexEntry {
  /** Figma variable name. */
  name: string;
  /** Full dotted path. */
  codeKey: string;
  type: PlannedVariable["type"];
  /** Literal value when the token has one (aliases resolve to null). */
  literal: string | number | boolean | null;
}

export type TokenIndex = Map<string, TokenIndexEntry>;

export interface TokensPlanResult {
  plan: TokensPlan;
  index: TokenIndex;
}

export function planTokens(tokensFile: string, config: BatchConfig): TokensPlanResult {
  let raw: string;
  try {
    raw = readFileSync(tokensFile, "utf8");
  } catch {
    throw new Error(`Tokens file not found: ${tokensFile}.`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Tokens file is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(data)) throw new Error(`Tokens file must be a JSON object: ${tokensFile}.`);

  const index: TokenIndex = new Map();
  const primitives: PlannedVariable[] = [];
  for (const [key, node] of Object.entries(data)) {
    if (RESERVED.has(key)) continue;
    walkPrimitives(node, [key], (path, leaf) => {
      const variable = primitiveVariable(path, leaf);
      primitives.push(variable);
      index.set(path, {
        name: variable.name,
        codeKey: path,
        type: variable.type,
        literal: variable.values.Value as string | number | boolean,
      });
    });
  }

  if (index.size === 0 && !data.semantic) {
    throw new Error(`Tokens file has no primitives and no "semantic" section: ${tokensFile}.`);
  }

  const semantic = planSemantic(data.semantic, config, index);
  const textStyles = planTextStyles(data.textStyles, index);
  const effectStyles = planEffectStyles(data.effectStyles);

  return {
    plan: {
      primitives: { collection: config.collections.primitives, modes: ["Value"], variables: primitives },
      semantic: semantic.forModes,
      semanticCollections: semantic.forCollections,
      textStyles,
      effectStyles,
    },
    index,
  };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function walkPrimitives(
  node: unknown,
  path: string[],
  visit: (path: string, leaf: Record<string, unknown>) => void,
): void {
  if (isRecord(node) && "value" in node) {
    visit(path.join("."), node);
    return;
  }
  if (!isRecord(node)) {
    throw new Error(`Token "${path.join(".")}" must be an object with a "value", or a group of such objects.`);
  }
  for (const [key, child] of Object.entries(node)) {
    walkPrimitives(child, [...path, key], visit);
  }
}

function primitiveVariable(path: string, leaf: Record<string, unknown>): PlannedVariable {
  const typeName = String(leaf.type ?? "");
  const type = PRIMITIVE_TYPES[typeName];
  if (!type) {
    throw new Error(
      `Token "${path}" has type ${JSON.stringify(leaf.type ?? null)} — ` +
        `use one of: ${Object.keys(PRIMITIVE_TYPES).join(", ")}.`,
    );
  }

  const value = leaf.value;
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`Token "${path}" has a non-literal value.`);
  }
  if (type === "COLOR" && typeof value !== "string") {
    throw new Error(`Token "${path}" is a color, so "value" must be a hex/rgb() string.`);
  }
  if (type === "FLOAT" && typeof value !== "number") {
    throw new Error(`Token "${path}" is a dimension, so "value" must be a number.`);
  }
  if (type === "STRING" && typeof value !== "string") {
    throw new Error(`Token "${path}" is a font family, so "value" must be a string.`);
  }

  return {
    codeKey: path,
    name: path.replaceAll(".", "/"),
    type,
    scopes: PRIMITIVE_SCOPES[type],
    values: { Value: value },
  };
}

// ---------------------------------------------------------------------------
// Semantic tokens
// ---------------------------------------------------------------------------

interface SemanticPlan {
  forModes: TokensPlan["semantic"];
  forCollections?: TokensPlan["semanticCollections"];
}

function planSemantic(node: unknown, config: BatchConfig, index: TokenIndex): SemanticPlan {
  if (node === undefined) {
    const empty = { collection: config.collections.semantic, modes: config.semanticModes, variables: [] };
    return config.modeStrategy === "collections"
      ? {
          forModes: empty,
          forCollections: config.semanticModes.map((mode) => ({
            collection: `${config.collections.semantic} ${mode}`,
            mode,
            variables: [],
          })),
        }
      : { forModes: empty };
  }
  if (!isRecord(node)) throw new Error(`"semantic" must be an object.`);
  if (!MODE_STRATEGIES.has(config.modeStrategy)) {
    throw new Error(`Unknown modeStrategy "${config.modeStrategy}".`);
  }

  const leaves: { path: string; leaf: Record<string, unknown> }[] = [];
  walkPrimitives(node, ["semantic"], (path, leaf) => leaves.push({ path, leaf }));

  const byMode = new Map<string, PlannedVariable[]>(
    config.semanticModes.map((mode) => [mode, []]),
  );

  for (const { path, leaf } of leaves) {
    const shortPath = path.split(".").slice(1).join("."); // drop the "semantic" root
    if (!shortPath) throw new Error(`Semantic token at "${path}" needs at least one group below "semantic".`);

    const modes = isRecord(leaf.modes) ? (leaf.modes as Record<string, unknown>) : null;
    if (modes) {
      for (const modeName of Object.keys(modes)) {
        if (!config.semanticModes.includes(modeName)) {
          throw new Error(
            `Semantic token "${path}" sets mode "${modeName}", but semanticModes is ` +
              `[${config.semanticModes.join(", ")}].`,
          );
        }
      }
      if (leaf.value === undefined) {
        for (const modeName of config.semanticModes) {
          if (modes[modeName] === undefined) {
            throw new Error(`Semantic token "${path}" has no value for mode "${modeName}" and no fallback "value".`);
          }
        }
      }
    }

    for (const modeName of config.semanticModes) {
      const effective = modes?.[modeName] ?? leaf.value;
      if (effective === undefined) {
        throw new Error(`Semantic token "${path}" has no value for mode "${modeName}".`);
      }
      const variable = semanticVariable(path, shortPath, leaf, effective, modeName, index);
      const current = byMode.get(modeName) as PlannedVariable[];
      const existing = current.find((candidate) => candidate.codeKey === variable.codeKey);
      if (existing) existing.values[modeName] = variable.values[modeName];
      else current.push(variable);
    }

    // Register the semantic token so sidecars can reference it by path.
    // It is an alias, so it has no literal value of its own.
    const created = byMode.get(config.semanticModes[0])?.find((variable) => variable.codeKey === path);
    if (created) {
      index.set(path, { name: created.name, codeKey: path, type: created.type, literal: null });
    }
  }

  if (config.modeStrategy === "collections") {
    return {
      forModes: {
        collection: config.collections.semantic,
        modes: config.semanticModes,
        // Kept populated so callers can report on it; only collections are used.
        variables: [],
      },
      forCollections: config.semanticModes.map((mode) => ({
        collection: `${config.collections.semantic} ${mode}`,
        mode,
        variables: (byMode.get(mode) as PlannedVariable[]).map((variable) => ({
          ...variable,
          values: { Value: variable.values[mode] },
        })),
      })),
    };
  }

  const variables: PlannedVariable[] = [];
  for (const mode of config.semanticModes) {
    for (const variable of byMode.get(mode) as PlannedVariable[]) {
      const existing = variables.find((candidate) => candidate.codeKey === variable.codeKey);
      if (existing) Object.assign(existing.values, variable.values);
      else variables.push({ ...variable, values: { ...variable.values } });
    }
  }

  return {
    forModes: { collection: config.collections.semantic, modes: config.semanticModes, variables },
  };
}

function semanticVariable(
  fullPath: string,
  shortPath: string,
  leaf: Record<string, unknown>,
  value: unknown,
  modeName: string,
  index: TokenIndex,
): PlannedVariable {
  const resolved = resolveTokenValue(value, fullPath, index);
  const declaredType = leaf.type === undefined ? undefined : String(leaf.type);
  if (declaredType !== undefined && !PRIMITIVE_TYPES[declaredType]) {
    throw new Error(
      `Semantic token "${fullPath}" has type ${JSON.stringify(leaf.type)} — ` +
        `use one of: ${Object.keys(PRIMITIVE_TYPES).join(", ")}.`,
    );
  }
  if (declaredType !== undefined && resolved.type && PRIMITIVE_TYPES[declaredType] !== resolved.type) {
    throw new Error(
      `Semantic token "${fullPath}" is declared ${declaredType} but points at a ${resolved.type} token.`,
    );
  }

  return {
    codeKey: fullPath,
    name: shortPath.replaceAll(".", "/"),
    type: declaredType ? PRIMITIVE_TYPES[declaredType] : (resolved.type ?? "COLOR"),
    scopes: PRIMITIVE_SCOPES[declaredType ? PRIMITIVE_TYPES[declaredType] : (resolved.type ?? "COLOR")],
    values: { [modeName]: resolved.binding },
  };
}

/** A `{path}` reference becomes `{ variable: figmaName }`; literals pass through. */
function resolveTokenValue(
  value: unknown,
  context: string,
  index: TokenIndex,
): { binding: unknown; type: PlannedVariable["type"] | null } {
  if (typeof value === "number" || typeof value === "boolean") {
    return { binding: value, type: value === true || value === false ? "BOOLEAN" : "FLOAT" };
  }
  if (typeof value !== "string") {
    throw new Error(`Semantic token "${context}" has an unsupported value: ${JSON.stringify(value)}.`);
  }

  const ref = normalizeRef(value);
  const target = index.get(ref);
  if (target) {
    return { binding: { variable: target.name }, type: target.type };
  }
  if (value.startsWith("#") || /^rgba?\(/.test(value)) {
    return { binding: value, type: "COLOR" };
  }
  throw new Error(
    `Semantic token "${context}" references "${ref}", which is not a known token path.`,
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function planTextStyles(node: unknown, index: TokenIndex): PlannedTextStyle[] {
  if (node === undefined) return [];
  if (!isRecord(node)) throw new Error(`"textStyles" must be an object of named styles.`);

  return Object.entries(node).map(([name, raw]) => {
    if (!isRecord(raw)) throw new Error(`Text style "${name}" must be an object.`);
    const params: Record<string, unknown> = { name, codeKey: name };

    if (raw.description !== undefined) params.description = String(raw.description);
    if (raw.fontFamily !== undefined) {
      params.fontFamily = styleLiteral(raw.fontFamily, "STRING", name, "fontFamily", index);
    }
    if (raw.fontStyle !== undefined) params.fontStyle = String(raw.fontStyle);
    if (raw.fontSize !== undefined) {
      params.fontSize = styleLiteral(raw.fontSize, "FLOAT", name, "fontSize", index);
    }
    if (raw.lineHeight !== undefined) params.lineHeight = raw.lineHeight;
    if (raw.letterSpacing !== undefined) params.letterSpacing = raw.letterSpacing;

    if (params.fontFamily === undefined && params.fontSize === undefined) {
      throw new Error(
        `Text style "${name}" sets nothing to change — give it at least "fontSize" or "fontFamily".`,
      );
    }
    return { key: name, params };
  });
}

function planEffectStyles(node: unknown): PlannedEffectStyle[] {
  if (node === undefined) return [];
  if (!isRecord(node)) throw new Error(`"effectStyles" must be an object of named styles.`);

  return Object.entries(node).map(([name, raw]) => {
    if (!isRecord(raw)) throw new Error(`Effect style "${name}" must be an object.`);
    const effects = raw.effects;
    if (!Array.isArray(effects) || effects.length === 0) {
      throw new Error(`Effect style "${name}" needs a non-empty "effects" array.`);
    }
    const params: Record<string, unknown> = { name, codeKey: name, effects };
    if (raw.description !== undefined) params.description = String(raw.description);
    return { key: name, params };
  });
}

/** Style fields need literal values — a `{token}` reference must resolve to one. */
function styleLiteral(
  value: unknown,
  expected: PlannedVariable["type"],
  styleName: string,
  field: string,
  index: TokenIndex,
): string | number {
  if (expected === "FLOAT" && typeof value === "number") return value;
  if (typeof value !== "string") {
    throw new Error(`Text style "${styleName}": "${field}" must be a literal or a {token} reference.`);
  }

  const ref = normalizeRef(value);
  const target = index.get(ref);
  if (!target) {
    throw new Error(`Text style "${styleName}": "${field}" references "${ref}", which is not a known token path.`);
  }
  if (target.type !== expected) {
    throw new Error(`Text style "${styleName}": "${field}" needs a ${expected} token, but "${ref}" is ${target.type}.`);
  }
  if (target.literal === null || typeof target.literal === "boolean") {
    throw new Error(
      `Text style "${styleName}": "${field}" references "${ref}", an alias without a literal value — ` +
        `point at the primitive instead.`,
    );
  }
  return target.literal;
}

/** Accepts both `color.primary.500` and `{color.primary.500}`. */
export function normalizeRef(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1).trim() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
