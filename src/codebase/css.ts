import { readFileSync } from "node:fs";
import { categoryFromName, cssColorToHex, slugify, toPx } from "../normalize.js";
import type { Category, Token } from "../types.js";

export function parseCss(cssPath: string): Token[] {
  const text = readFileSync(cssPath, "utf8");
  const tokens: Token[] = [];

  for (const match of text.matchAll(/:root\s*\{([\s\S]*?)\}/g)) {
    const propertyRe = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
    let property: RegExpExecArray | null;
    while ((property = propertyRe.exec(match[1])) !== null) {
      const name = slugify(property[1].replace(/^--/, ""));
      const rawValue = property[2].trim().replace(/\s*!important$/, "").trim();
      const token = toToken(name, rawValue);
      if (token) tokens.push(token);
    }
  }

  return tokens;
}

function toToken(name: string, rawValue: string): Token | null {
  const category = categoryFromName(name);

  if (category === "color") {
    const hex = cssColorToHex(rawValue);
    return hex ? { name, category, value: hex, source: "code" } : null;
  }

  if (category === "typography" || category === "spacing") {
    const px = toPx(rawValue);
    if (px) return { name, category, value: px, source: "code" };
    if (category === "typography") return { name, category, value: rawValue, source: "code" };
    return null;
  }

  const fallback = inferCategory(rawValue);
  if (fallback) return { name, category: fallback, value: rawValue, source: "code" };
  return null;
}

function inferCategory(value: string): Category | null {
  if (/^(#|rgb|hsl)/.test(value.trim())) return "color";
  if (toPx(value)) return "spacing";
  return null;
}
