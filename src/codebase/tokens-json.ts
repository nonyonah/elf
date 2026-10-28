import {parseImportedTokens} from '../token-import.js';
import { readFileSync } from "node:fs";
import { categoryFromName, cssColorToHex, normalizeShadow, slugify, toPx } from "../core/normalize.js";
import type { Category, Token } from "../core/types.js";

const TYPE_TO_CATEGORY: Record<string, Category> = {
  color: "color",
  dimension: "spacing",
  spacing: "spacing",
  sizing: "spacing",
  fontSizes: "typography",
  fontSize: "typography",
  fontFamilies: "typography",
  fontFamily: "typography",
  fontWeight: "typography",
  fontWeights: "typography",
  typography: "typography",
  borderRadius: "radius",
  radius: "radius",
  boxShadow: "shadow",
  shadow: "shadow",
};

export function parseTokensJson(jsonPath: string, contents?: string): Token[] {
  const data = JSON.parse(contents ?? readFileSync(jsonPath, "utf8")) as Record<string, unknown>;
  if (Object.hasOwn(data, "$elfFigmaImport")) return parseImportedTokens(data);
  const tokens: Token[] = [];

  const walk = (node: Record<string, unknown>, path: string[]): void => {
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if ("value" in record || "$value" in record) {
          const rawValue = (record.value ?? record.$value) as unknown;
          const declaredType = (record.type ?? record.$type) as string | undefined;
          const name = [...path, key].map(slugify).join("-");
          const token = toToken(name, rawValue, declaredType);
          if (token) tokens.push(token);
        } else {
          walk(record, [...path, key]);
        }
      } else if (typeof value === "string" || typeof value === "number") {
        const name = [...path, key].map(slugify).join("-");
        const token = toToken(name, value);
        if (token) tokens.push(token);
      }
    }
  };

  walk(data, []);
  return tokens;
}

function toToken(name: string, rawValue: unknown, declaredType?: string): Token | null {
  if (typeof rawValue !== "string" && typeof rawValue !== "number") return null;

  const category = resolveCategory(name, declaredType, rawValue);
  if (!category) return null;

  if (category === "color") {
    const hex = cssColorToHex(String(rawValue));
    return hex ? { name, category, value: hex, source: "code" } : null;
  }

  if (category === "spacing" || category === "radius") {
    const px = toPx(rawValue);
    return px ? { name, category, value: px, source: "code" } : null;
  }

  if (category === "shadow") {
    const shadow = normalizeShadow(String(rawValue));
    return shadow ? { name, category, value: shadow, source: "code" } : null;
  }

  const isFontWeight = declaredType === "fontWeight" || declaredType === "fontWeights";
  const px = isFontWeight ? null : toPx(rawValue);
  return { name, category, value: px ?? String(rawValue), source: "code" };
}

function resolveCategory(
  name: string,
  declaredType: string | undefined,
  rawValue: string | number,
): Category | null {
  const named = categoryFromName(name);
  // A radius/shadow name beats a generic "dimension" declaration many token
  // files use for anything numeric.
  if (named === "radius" || named === "shadow") return named;
  const declared = declaredType ? TYPE_TO_CATEGORY[declaredType] : undefined;
  if (declared) return declared;
  if (named !== "other") return named;
  return inferCategory(rawValue);
}

function inferCategory(value: string | number): Category | null {
  const text = String(value).trim();
  if (/^(#|rgb|hsl)/.test(text)) return "color";
  if (toPx(value)) return "spacing";
  if (typeof value === "number") return "spacing";
  return null;
}
