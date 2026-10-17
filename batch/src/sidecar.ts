import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { normalizeRef, type TokenIndex } from "./tokens.js";
import type { ParsedComponent, SidecarSpec, SidecarVariant, Variant } from "./types.js";

/**
 * `<Name>.figma.json` next to the component. Values reference tokens by their
 * dotted name — `"color.surface.base"` or `"{color.surface.base}"` — never raw
 * values. Numbers are literals. The only literal strings are `text.characters`
 * and `fontStyle`, which are content, not design values.
 *
 *   {
 *     "layoutMode": "VERTICAL",
 *     "padding": { "all": "space.4" },
 *     "gap": "space.2",
 *     "cornerRadius": "radius.md",
 *     "fill": "color.surface.base",
 *     "stroke": { "color": "color.line.inputSoft", "weight": 1 },
 *     "text": { "characters": "Continue", "fontSize": "fontSize.body", "color": "color.onPrimary" },
 *     "children": [ { "type": "instance", "component": "card.tsx#Card" } ],
 *     "variants": { "size=sm, intent=primary": { "padding": { "all": "space.2" } } }
 *   }
 */

const KNOWN_FIELDS = new Set([
  "layoutMode",
  "padding",
  "gap",
  "cornerRadius",
  "fill",
  "stroke",
  "size",
  "text",
  "children",
]);

const LAYOUT_MODES = new Set(["HORIZONTAL", "VERTICAL", "NONE"]);

/** Reads (but does not yet validate) the sidecar; null when the file is missing. */
export function loadSidecar(componentsDir: string, parsed: ParsedComponent): SidecarSpec | null {
  const componentPath = resolve(componentsDir, parsed.file);
  const sidecarPath = componentPath.slice(0, -extname(componentPath).length) + ".figma.json";
  let raw: string;
  try {
    raw = readFileSync(sidecarPath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as SidecarSpec;
  } catch (error) {
    throw new Error(`${sidecarPath} is not valid JSON: ${(error as Error).message}`);
  }
}

export function sidecarPathFor(componentsDir: string, parsed: ParsedComponent): string {
  const componentPath = resolve(componentsDir, parsed.file);
  return componentPath.slice(0, -extname(componentPath).length) + ".figma.json";
}

/** Strict shape validation — unknown fields are errors, not silently dropped. */
export function validateSidecar(sidecar: SidecarSpec, label: string): SidecarSpec {
  if (typeof sidecar !== "object" || sidecar === null || Array.isArray(sidecar)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  for (const key of Object.keys(sidecar)) {
    if (!KNOWN_FIELDS.has(key) && key !== "variants") {
      throw new Error(
        `${label}: unknown field "${key}". Known fields: ${[...KNOWN_FIELDS].join(", ")}, variants.`,
      );
    }
  }
  if (sidecar.layoutMode !== undefined && !LAYOUT_MODES.has(String(sidecar.layoutMode))) {
    throw new Error(`${label}: "layoutMode" must be HORIZONTAL, VERTICAL or NONE.`);
  }
  if (sidecar.variants !== undefined) {
    if (typeof sidecar.variants !== "object" || sidecar.variants === null || Array.isArray(sidecar.variants)) {
      throw new Error(`${label}: "variants" must be an object keyed by variant label.`);
    }
    for (const [variantLabel, overrides] of Object.entries(sidecar.variants)) {
      if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
        throw new Error(`${label}: variant "${variantLabel}" must be an object of overrides.`);
      }
      for (const key of Object.keys(overrides)) {
        if (!KNOWN_FIELDS.has(key)) {
          throw new Error(`${label}: variant "${variantLabel}" has unknown field "${key}".`);
        }
      }
    }
  }
  return sidecar;
}

export interface ResolvedSidecar {
  /** Set-level (or plain-component) plugin params. */
  shared: Record<string, unknown>;
  /** Per-variant overrides, keyed by variant label. */
  perVariant: Record<string, Record<string, unknown>>;
}

/**
 * Turns token references into plugin-call params. `{token}` refs become
 * `{ variable: figmaName }` bindings; refs in text fields that Figma cannot
 * bind (font family, font size) resolve to the token's literal value.
 */
export function resolveSidecar(
  sidecar: SidecarSpec,
  variants: Variant[],
  index: TokenIndex,
  label: string,
): ResolvedSidecar {
  const shared = translateFields(sidecar, index, label);
  const perVariant: Record<string, Record<string, unknown>> = {};

  for (const [variantLabel, overrides] of Object.entries(sidecar.variants ?? {})) {
    const match = variants.find((variant) => variant.label === variantLabel);
    if (!match) {
      const known = variants.map((variant) => variant.label).join(" / ") || "none — this component has no variant props";
      throw new Error(`${label}: variant "${variantLabel}" does not exist. Variants: ${known}.`);
    }
    const translated = translateFields(overrides, index, label);
    if (Object.keys(translated).length > 0) perVariant[variantLabel] = translated;
  }

  return { shared, perVariant };
}

function translateFields(
  raw: SidecarSpec | SidecarVariant,
  index: TokenIndex,
  label: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  if (raw.layoutMode !== undefined) out.layoutMode = String(raw.layoutMode);
  if (raw.padding !== undefined) out.padding = translatePadding(raw.padding, index, label);
  if (raw.gap !== undefined) out.gap = numberOrRef(raw.gap, "gap", index, label);
  if (raw.cornerRadius !== undefined) out.cornerRadius = numberOrRef(raw.cornerRadius, "cornerRadius", index, label);
  if (raw.fill !== undefined) out.fill = translateFill(raw.fill, index, label, "fill");
  if (raw.stroke !== undefined) out.stroke = translateStroke(raw.stroke, index, label);
  if (raw.size !== undefined) out.size = translateSize(raw.size, label);
  if (raw.text !== undefined) out.text = translateText(raw.text, index, label);
  if (raw.children !== undefined) out.children = translateChildren(raw.children, label);

  return out;
}

function translatePadding(value: unknown, index: TokenIndex, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: "padding" must be an object like { "all": "space.4" }.`);
  }
  const out: Record<string, unknown> = {};
  for (const [side, sideValue] of Object.entries(value)) {
    if (!["all", "top", "right", "bottom", "left"].includes(side)) {
      throw new Error(`${label}: "padding.${side}" is not a side — use all/top/right/bottom/left.`);
    }
    out[side] = numberOrRef(sideValue, `padding.${side}`, index, label);
  }
  return out;
}

function numberOrRef(
  value: unknown,
  field: string,
  index: TokenIndex,
  label: string,
): number | { variable: string } {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label}: "${field}" must be a finite number.`);
    return value;
  }
  if (typeof value === "string") {
    const target = index.get(normalizeRef(value));
    if (!target) throw new Error(`${label}: "${field}" references "${normalizeRef(value)}", which is not a known token.`);
    if (target.type !== "FLOAT") {
      throw new Error(`${label}: "${field}" needs a dimension token, but "${normalizeRef(value)}" is ${target.type}.`);
    }
    return { variable: target.name };
  }
  throw new Error(`${label}: "${field}" must be a number or a {token} reference.`);
}

function translateFill(
  value: unknown,
  index: TokenIndex,
  label: string,
  field: string,
): Record<string, unknown> {
  if (typeof value === "string") {
    return { variable: colorRef(value, field, index, label) };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.variable !== undefined) {
      const out: Record<string, unknown> = { variable: colorRef(String(object.variable), field, index, label) };
      if (object.color !== undefined) out.color = String(object.color);
      return out;
    }
    if (object.color !== undefined) return { color: String(object.color) };
  }
  throw new Error(`${label}: "${field}" must be a color token reference (or { variable, color }).`);
}

function colorRef(value: string, field: string, index: TokenIndex, label: string): string {
  const target = index.get(normalizeRef(value));
  if (!target) throw new Error(`${label}: "${field}" references "${normalizeRef(value)}", which is not a known token.`);
  if (target.type !== "COLOR") {
    throw new Error(`${label}: "${field}" needs a color token, but "${normalizeRef(value)}" is ${target.type}.`);
  }
  return target.name;
}

function translateStroke(value: unknown, index: TokenIndex, label: string): Record<string, unknown> {
  if (typeof value === "string") {
    return { color: { variable: colorRef(value, "stroke", index, label) } };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (object.color === undefined) throw new Error(`${label}: "stroke" needs a "color" — a {token} reference.`);
    const out: Record<string, unknown> = { color: translateFill(object.color, index, label, "stroke.color") };
    if (object.weight !== undefined) {
      const weight = Number(object.weight);
      if (!Number.isFinite(weight) || weight < 0) {
        throw new Error(`${label}: "stroke.weight" must be a non-negative number.`);
      }
      out.weight = weight;
    }
    return out;
  }
  throw new Error(`${label}: "stroke" must be a color token reference (or { color, weight }).`);
}

function translateSize(value: unknown, label: string): { width: number; height: number } {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label}: "size" must be { "width": n, "height": n }.`);
  }
  const { width, height } = value as { width?: unknown; height?: unknown };
  if (!Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    throw new Error(`${label}: "size" needs finite width and height.`);
  }
  return { width: Number(width), height: Number(height) };
}

function translateText(value: unknown, index: TokenIndex, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: "text" must be an object with "characters".`);
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.characters !== "string") {
    throw new Error(`${label}: "text.characters" is required and must be a string.`);
  }
  const out: Record<string, unknown> = { characters: raw.characters };

  if (raw.fontFamily !== undefined) {
    out.fontFamily = literalFromToken(raw.fontFamily, "STRING", "text.fontFamily", index, label);
  }
  if (raw.fontStyle !== undefined) out.fontStyle = String(raw.fontStyle);
  if (raw.fontSize !== undefined) {
    out.fontSize = literalFromToken(raw.fontSize, "FLOAT", "text.fontSize", index, label);
  }
  if (raw.color !== undefined) {
    out.color = translateFill(raw.color, index, label, "text.color");
  }
  return out;
}

function translateChildren(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}: "children" must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${label}: child ${index} must be an object.`);
    }
    const child = entry as Record<string, unknown>;
    if (child.type !== "instance") {
      throw new Error(`${label}: child ${index} must have "type": "instance".`);
    }
    if (typeof child.component !== "string" || !child.component.trim()) {
      throw new Error(`${label}: child ${index} needs "component" — the codeKey of another component.`);
    }
    return { type: "instance", component: child.component };
  });
}

/** For fields Figma can't bind: resolve `{token}` to its literal value. */
function literalFromToken(
  value: unknown,
  expected: "STRING" | "FLOAT",
  field: string,
  index: TokenIndex,
  label: string,
): string | number {
  if (expected === "FLOAT" && typeof value === "number") return value;
  if (typeof value !== "string") {
    throw new Error(`${label}: "${field}" must be a literal or a {token} reference.`);
  }
  const ref = normalizeRef(value);
  const target = index.get(ref);
  if (!target) throw new Error(`${label}: "${field}" references "${ref}", which is not a known token.`);
  if (target.type !== expected) {
    throw new Error(`${label}: "${field}" needs a ${expected} token, but "${ref}" is ${target.type}.`);
  }
  if (target.literal === null || typeof target.literal === "boolean") {
    throw new Error(`${label}: "${field}" references "${ref}", an alias without a literal value.`);
  }
  return target.literal;
}
