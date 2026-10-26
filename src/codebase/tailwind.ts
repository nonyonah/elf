import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cssColorToHex, normalizeShadow, slugify, toPx } from "../core/normalize.js";
import type { Token } from "../core/types.js";

type ThemeSection = Record<string, unknown>;

interface TailwindTheme {
  colors?: ThemeSection;
  spacing?: ThemeSection;
  fontSize?: ThemeSection;
  fontFamily?: ThemeSection;
  borderRadius?: ThemeSection;
  boxShadow?: ThemeSection;
  extend?: TailwindTheme;
}

export async function parseTailwindConfig(configPath: string): Promise<Token[]> {
  const module = await import(pathToFileURL(resolve(configPath)).href);
  const raw = (module.default ?? module) as Record<string, unknown>;
  const config = (raw ?? {}) as { theme?: TailwindTheme };

  return tokensFromTailwindTheme(config.theme ?? {});
}

export function tokensFromTailwindTheme(theme: TailwindTheme): Token[] {
  const tokens = new Map<string, Token>();

  const push = (token: Token) => tokens.set(token.name, token);

  walkColors(deepMerge(theme.colors ?? {}, theme.extend?.colors ?? {}), "", push);
  walkSpacing(deepMerge(theme.spacing ?? {}, theme.extend?.spacing ?? {}), push);
  walkFontSizes(deepMerge(theme.fontSize ?? {}, theme.extend?.fontSize ?? {}), push);
  walkFontFamilies(deepMerge(theme.fontFamily ?? {}, theme.extend?.fontFamily ?? {}), push);
  walkRadii(deepMerge(theme.borderRadius ?? {}, theme.extend?.borderRadius ?? {}), push);
  walkShadows(deepMerge(theme.boxShadow ?? {}, theme.extend?.boxShadow ?? {}), push);

  return [...tokens.values()];
}

function deepMerge(base: unknown, extra: unknown): ThemeSection {
  if (!base || typeof base !== "object" || Array.isArray(base)) {
    return (extra ?? base) as ThemeSection;
  }
  const out: ThemeSection = { ...(base as ThemeSection) };
  for (const [key, value] of Object.entries((extra ?? {}) as ThemeSection)) {
    out[key] = deepMerge((base as ThemeSection)[key], value);
  }
  return out;
}

function walkColors(section: ThemeSection, prefix: string, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    const name = key === "DEFAULT" || key === "default" ? prefix : joinName(prefix, key);
    if (typeof value === "string") {
      const hex = cssColorToHex(value);
      if (hex) push({ name, category: "color", value: hex, source: "code" });
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      walkColors(value as ThemeSection, name, push);
    }
  }
}

function walkSpacing(section: ThemeSection, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    const px = toPx(value as string | number);
    if (!px) continue;
    const name = key.startsWith("spacing") ? slugify(key) : `spacing-${slugify(key)}`;
    push({ name, category: "spacing", value: px, source: "code" });
  }
}

function walkFontSizes(section: ThemeSection, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    const sizeValue = Array.isArray(value) ? value[0] : value;
    const px = toPx(sizeValue as string | number);
    if (!px) continue;
    push({ name: `font-size-${slugify(key)}`, category: "typography", value: px, source: "code" });
  }
}

function walkFontFamilies(section: ThemeSection, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    const family = Array.isArray(value) ? value[0] : value;
    if (typeof family !== "string") continue;
    push({ name: `font-family-${slugify(key)}`, category: "typography", value: family, source: "code" });
  }
}

function walkRadii(section: ThemeSection, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const px = toPx(value);
    if (!px) continue;
    const name = key === "DEFAULT" || key === "default" ? "radius" : `radius-${slugify(key)}`;
    push({ name, category: "radius", value: px, source: "code" });
  }
}

function walkShadows(section: ThemeSection, push: (token: Token) => void): void {
  for (const [key, value] of Object.entries(section)) {
    // Layers may be a single string or an array of layer strings.
    const raw = Array.isArray(value)
      ? value.filter((layer): layer is string => typeof layer === "string").join(", ")
      : value;
    if (typeof raw !== "string") continue;
    const normalized = normalizeShadow(raw);
    if (!normalized) continue;
    const name = key === "DEFAULT" || key === "default" ? "shadow" : `shadow-${slugify(key)}`;
    push({ name, category: "shadow", value: normalized, source: "code" });
  }
}

function joinName(prefix: string, key: string): string {
  return prefix ? `${prefix}-${slugify(key)}` : slugify(key);
}
