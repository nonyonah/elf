import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FigmaApi } from "./figma/client.js";
import type { DriftConfig } from "./types.js";

const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export type SampleFormat = "variables" | "styles" | "tailwind" | "css" | "tokens-json";

export function buildSampleConfig(format?: SampleFormat): DriftConfig {
  const colorMapping: Record<string, string> = {
    "color-primary-500": "primary-500",
    "color-primary-400": "primary-400",
    "color-accent-500": "accent-500",
    "color-accent-400": "accent-400",
    "color-neutral-0": "neutral-0",
    "color-danger-500": "danger-500",
    "color-info-500": "info-500",
  };

  const base: DriftConfig = {
    figma: {
      fileKey: "SAMPLE_FILE_KEY",
      apiTokenEnv: "FIGMA_API_TOKEN",
      source: "variables",
      teamId: "SAMPLE_TEAM_ID",
    },
    codebase: { path: join(FIXTURES_DIR, "tailwind.config.cjs"), source: "tailwind" },
    modeName: null,
    nameMapping: colorMapping,
  };

  switch (format) {
    case "styles":
      return { ...base, figma: { ...base.figma, source: "styles" } };
    case "css":
      return { ...base, codebase: { ...base.codebase, path: join(FIXTURES_DIR, "tokens.css"), source: "css" }, nameMapping: {} };
    case "tokens-json":
      return { ...base, codebase: { ...base.codebase, path: join(FIXTURES_DIR, "tokens.json"), source: "tokens-json" }, nameMapping: {} };
    case "tailwind":
    case "variables":
    default:
      return base;
  }
}

export function createSampleFigmaApi(): FigmaApi {
  const cache = new Map<string, unknown>();

  const fixtureFor = (path: string): string => {
    if (path.includes("/variables/local")) return join(FIXTURES_DIR, "figma-variables.json");
    if (path.includes("/styles")) return join(FIXTURES_DIR, "figma-styles.json");
    if (path.includes("/nodes")) return join(FIXTURES_DIR, "figma-nodes.json");
    throw new Error(`Sample mode has no fixture for "${path}".`);
  };

  return {
    async get<T>(path: string): Promise<T> {
      if (cache.has(path)) return cache.get(path) as T;
      const data = JSON.parse(readFileSync(fixtureFor(path), "utf8")) as T;
      cache.set(path, data);
      return data;
    },
  };
}
