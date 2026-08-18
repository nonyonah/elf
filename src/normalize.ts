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
const SKIPPED_WORDS = ["radius", "border", "shadow", "easing", "duration", "opacity"];

export function categoryFromName(name: string): Category | "other" {
  if (SKIPPED_WORDS.some((word) => name.includes(word))) return "other";
  if (COLOR_WORDS.some((word) => name.includes(word))) return "color";
  if (TYPOGRAPHY_WORDS.some((word) => name.includes(word))) return "typography";
  if (SPACING_WORDS.some((word) => name.includes(word))) return "spacing";
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
    const channel = (i: number) =>
      args[i].endsWith("%") ? (parseFloat(args[i]) / 100) * 2.55 : parseFloat(args[i]);
    return rgbToHex(channel(0), channel(1), channel(2), alpha);
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
