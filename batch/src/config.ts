import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { BatchConfig, ModeStrategy } from "./types.js";

export const CONFIG_FILE = "elf-batch.config.json";
export const MANIFEST_FILE = "elf.manifest.json";
export const DEFAULT_CHUNK_SIZE = 5;

interface RawConfig {
  tokens?: string;
  components?: string;
  manifest?: string;
  modeStrategy?: string;
  semanticModes?: string[];
  chunkSize?: number;
  collections?: { primitives?: string; semantic?: string };
}

/**
 * Loads and validates `elf-batch.config.json`. All paths are resolved
 * relative to the config file, so the CLI can run from anywhere.
 */
export function loadConfig(configPath: string): BatchConfig {
  const absolute = resolve(configPath);
  const root = dirname(absolute);

  const raw = readFile(absolute);
  const parsed = JSON.parse(raw) as RawConfig;

  if (!parsed.tokens) throw new Error(`"tokens" is required in ${absolute}.`);
  if (!parsed.components) throw new Error(`"components" is required in ${absolute}.`);

  const modeStrategy = parsed.modeStrategy ?? "modes";
  if (modeStrategy !== "modes" && modeStrategy !== "collections") {
    throw new Error(`"modeStrategy" must be "modes" or "collections" (got "${modeStrategy}") in ${absolute}.`);
  }

  const chunkSize = parsed.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error(`"chunkSize" must be a positive integer (got ${parsed.chunkSize}) in ${absolute}.`);
  }

  const semanticModes = parsed.semanticModes ?? ["Light", "Dark"];
  if (semanticModes.length === 0 || semanticModes.some((mode) => typeof mode !== "string" || !mode.trim())) {
    throw new Error(`"semanticModes" must be a non-empty array of names in ${absolute}.`);
  }

  return {
    configPath: absolute,
    root,
    tokensFile: resolveInside(root, parsed.tokens),
    componentsDir: resolveInside(root, parsed.components),
    manifestFile: resolveInside(root, parsed.manifest ?? MANIFEST_FILE),
    modeStrategy: modeStrategy as ModeStrategy,
    semanticModes,
    chunkSize,
    collections: {
      primitives: parsed.collections?.primitives ?? "Primitives",
      semantic: parsed.collections?.semantic ?? "Semantic",
    },
  };
}

function resolveInside(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Config file not found: ${path}.`);
  }
}
