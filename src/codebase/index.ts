import { basename, resolve } from "node:path";
import type { CodebaseSource, Token } from "../types.js";
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
      `Set "codebase.source" in drift-checker.config.json to one of: tailwind | css | tokens-json.`,
  );
}

export async function parseCodebaseTokens(source: CodebaseSource, path: string): Promise<Token[]> {
  const resolved = resolve(path);
  if (source === "tailwind") return parseTailwindConfig(resolved);
  if (source === "css") return parseCss(resolved);
  if (source === "tokens-json") return parseTokensJson(resolved);
  return parseCodebaseTokens(detectCodebaseSource(path), path);
}
