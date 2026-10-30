import type { Category } from "./types.js";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\/\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const COLOR_WORDS = ["color", "colour"];
const TYPOGRAPHY_WORDS = ["font", "typography", "type", "size", "leading", "tracking", "letter", "weight"];
const SPACING_WORDS = ["space", "spacing", "gap", "padding", "margin"];
const RADIUS_WORDS = ["radius", "corner", "rounded"];
const SHADOW_WORDS = ["shadow", "elevation"];
const SKIPPED_WORDS = ["easing", "duration", "opacity"];

export function categoryFromName(name: string): Category | "other" {
  // Opacity/easing/duration stay out of scope; they are not comparable values.
  if (SKIPPED_WORDS.some((word) => name.includes(word))) return "other";
  if (COLOR_WORDS.some((word) => name.includes(word))) return "color";
  if (TYPOGRAPHY_WORDS.some((word) => name.includes(word))) return "typography";
  if (SPACING_WORDS.some((word) => name.includes(word))) return "spacing";
  // radius before border, so "border-radius" is a radius and "border-width" stays out.
  if (RADIUS_WORDS.some((word) => name.includes(word))) return "radius";
  if (SHADOW_WORDS.some((word) => name.includes(word))) return "shadow";
  return "other";
}

export function rgbToHex(r: number, g: number, b: number, a = 1): string {
  const channel = (n: number) =>
    Math.round(Math.min(1, Math.max(0, n)) * 255)
      .toString(16)
      .padStart(2, "0");
  const hex = `#${channel(r)}${channel(g)}${channel(b)}`;
  if (a >= 0.995) return hex;
  return `${hex}${channel(a)}`;
}

export function cssColorToHex(input: string): string | null {
  const value = input.trim().toLowerCase();

  if (value.startsWith("#")) {
    let hex = value.slice(1);
    if (/^[0-9a-f]{3,4}$/.test(hex)) hex = hex.split("").map((c) => c + c).join("");
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
    if (hex.length === 8 && hex.endsWith("ff")) hex = hex.slice(0, 6);
    return `#${hex}`;
  }

  const match = value.match(/^(rgba?|hsla?)\s*\(([\s\S]+)\)$/);
  if (!match) return null;

  const fn = match[1];
  const args = match[2].replace(/\s*\/\s*/g, ",").split(/[\s,]+/).filter(Boolean);
  const alpha = args.length >= 4 ? parseFloat(args[3].replace("%", "")) / (args[3].endsWith("%") ? 100 : 1) : 1;

  if (fn.startsWith("rgb")) {
    if (args.length < 3) return null;
    // CSS numeric channels use 0–255; percentages and Figma channels use 0–1.
    const channel = (i: number) =>
      parseFloat(args[i]) / (args[i].endsWith("%") ? 100 : 255);
    const channels = [channel(0), channel(1), channel(2)];
    if (![...channels, alpha].every(Number.isFinite)) return null;
    return rgbToHex(channels[0], channels[1], channels[2], alpha);
  }

  if (args.length < 3) return null;
  const hue = (((parseFloat(args[0]) % 360) + 360) % 360) / 360;
  const saturation = parseFloat(args[1].replace("%", "")) / 100;
  const lightness = parseFloat(args[2].replace("%", "")) / 100;
  const [r, g, b] = hslToRgb(hue, saturation, lightness);
  return rgbToHex(r, g, b, alpha);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

export function toPx(value: string | number): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? `${value}px` : null;
  const match = value.trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)(rem|px)?$/);
  if (!match) return null;
  const n = parseFloat(match[1]);
  if (match[2] === "rem") return `${Math.round(n * 16 * 100) / 100}px`;
  return `${n}px`;
}

// ---------------------------------------------------------------------------
// Shadows — compared as one normalized string: `[inset ]x y blur spread #color`
// ---------------------------------------------------------------------------

export interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: { r: number; g: number; b: number; a?: number };
}

/**
 * CSS `box-shadow` → canonical string, so the same shadow written two ways
 * compares equal. Unparseable values (named colors, `var(…)`, `none`,
 * `currentColor`) return null and are skipped rather than guessed.
 */
export function normalizeShadow(value: string): string | null {
  const text = value.trim();
  if (!text || /^none$/i.test(text)) return null;

  const layers: string[] = [];
  for (const layer of splitTopLevel(text, ",")) {
    const normalized = normalizeShadowLayer(layer.trim());
    if (normalized === null) return null;
    layers.push(normalized);
  }
  return layers.length > 0 ? layers.join(", ") : null;
}

function normalizeShadowLayer(layer: string): string | null {
  let inset = false;
  const lengths: string[] = [];
  let color: string | null = null;

  for (const token of splitTopLevel(layer, " ")) {
    if (!token) continue;
    if (token.toLowerCase() === "inset") {
      inset = true;
      continue;
    }
    const hex = token.includes("(") || token.startsWith("#") ? cssColorToHex(token) : null;
    if (hex !== null) {
      color = hex;
      continue;
    }
    const px = toPx(token);
    if (px !== null) {
      lengths.push(px);
      continue;
    }
    return null;
  }

  if (lengths.length < 2 || lengths.length > 4 || color === null) return null;
  while (lengths.length < 4) lengths.push("0px");
  return `${inset ? "inset " : ""}${lengths.join(" ")} ${color}`;
}

/** Figma drop/inner shadows → the same canonical string normalizeShadow produces. */
export function figmaEffectsToShadow(effects: readonly FigmaEffect[]): string | null {
  const layers = effects
    .filter(
      (effect) =>
        effect.visible !== false && (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW"),
    )
    .map((effect) => {
      const inset = effect.type === "INNER_SHADOW" ? "inset " : "";
      const x = effect.offset?.x ?? 0;
      const y = effect.offset?.y ?? 0;
      const blur = effect.radius ?? 0;
      const spread = effect.spread ?? 0;
      const color = effect.color
        ? rgbToHex(effect.color.r, effect.color.g, effect.color.b, effect.color.a ?? 1)
        : "#000000";
      return `${inset}${toPx(x)} ${toPx(y)} ${toPx(blur)} ${toPx(spread)} ${color}`;
    });
  return layers.length > 0 ? layers.join(", ") : null;
}

/** Splits on a separator that is outside parentheses — `rgb(0 0 0 / 1)` stays whole. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}
