import { readSource } from "../discovery.js";
import { parseStaticTailwind } from "./static-tailwind.js";
import type { DriftConfig } from "../core/types.js";
import { basename, resolve } from "node:path";
import type { CodebaseSource, Token } from "../core/types.js";
import { parseCss } from "./css.js";
import { parseTailwindConfig } from "./tailwind.js";
import { parseTokensJson } from "./tokens-json.js";

export function detectCodebaseSource(path: string): CodebaseSource {
  const base = basename(path).toLowerCase();
  if (
    base.startsWith("tailwind.config") &&
    (base.endsWith(".js") || base.endsWith(".cjs") || base.endsWith(".mjs") || base.endsWith(".ts"))
  ) {
    return "tailwind";
  }
  if (base.endsWith(".css")) return "css";
  if (base.endsWith(".json")) return "tokens-json";
  throw new Error(
    `Could not detect the token format from "${path}". ` +
      `Set "codebase.source" in elf.config.json to one of: tailwind | css | tokens-json.`,
  );
}

export async function parseCodebaseTokens(source: CodebaseSource, path: string): Promise<Token[]> {
  const resolved = resolve(path);
  if (source === "tailwind") return parseTailwindConfig(resolved);
  if (source === "css") return parseCss(resolved);
  if (source === "tokens-json") return parseTokensJson(resolved);
  return parseCodebaseTokens(detectCodebaseSource(path), path);
}

/** Merge discovered files deterministically; ambiguous values need review. */
export async function parseProjectTokens(codebase: DriftConfig["codebase"]): Promise<Token[]> {
  if (!codebase.paths) return parseCodebaseTokens(codebase.source, codebase.path);
  const tokens = new Map<string, Token>(); const origins = new Map<string, string>();
  for (const path of codebase.paths) {
    const source = detectCodebaseSource(path);
    const entries = source === "tailwind" ? parseStaticTailwind(path) : source === "css" ? parseCss(path, readSource(path)) : parseTokensJson(path, readSource(path));
    for (const token of entries) {
      const identity = `${token.name}\0${token.mode ?? ""}`;
      const previous = tokens.get(identity);
      if (previous && (previous.value !== token.value || previous.category !== token.category)) throw new Error(`Conflicting token "${token.name}" in ${origins.get(identity)} and ${path}. Use one value for this token or separate its names.`);
      tokens.set(identity, token); origins.set(identity, path);
    }
  }
  return [...tokens.values()];
}
