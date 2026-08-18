import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cssColorToHex, slugify, toPx } from "../normalize.js";
import type { Token } from "../types.js";

type ThemeSection = Record<string, unknown>;

interface TailwindTheme {
  colors?: ThemeSection;
  spacing?: ThemeSection;
  fontSize?: ThemeSection;
  fontFamily?: ThemeSection;
  extend?: TailwindTheme;
}

export async function parseTailwindConfig(configPath: string): Promise<Token[]> {
  const module = await import(pathToFileURL(resolve(configPath)).href);
  const raw = (module.default ?? module) as Record<string, unknown>;
  const config = (raw ?? {}) as { theme?: TailwindTheme };

  const theme = (config.theme ?? {}) as TailwindTheme;
  const tokens = new Map<string, Token>();

  const push = (token: Token) => tokens.set(token.name, token);

  walkColors(deepMerge(theme.colors ?? {}, theme.extend?.colors ?? {}), "", push);
  walkSpacing(deepMerge(theme.spacing ?? {}, theme.extend?.spacing ?? {}), push);
  walkFontSizes(deepMerge(theme.fontSize ?? {}, theme.extend?.fontSize ?? {}), push);
  walkFontFamilies(deepMerge(theme.fontFamily ?? {}, theme.extend?.fontFamily ?? {}), push);

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

function joinName(prefix: string, key: string): string {
  return prefix ? `${prefix}-${slugify(key)}` : slugify(key);
}
