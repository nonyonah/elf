import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DriftConfig } from "./types.js";

export function loadConfig(configPath: string): DriftConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (error) {
    throw new Error(`Could not read config "${configPath}": ${(error as Error).message}`);
  }

  const config = raw as Partial<DriftConfig>;

  if (!config.figma?.fileKey) {
    throw new Error(`Config "${configPath}" is missing "figma.fileKey".`);
  }
  if (!config.codebase?.path) {
    throw new Error(`Config "${configPath}" is missing "codebase.path".`);
  }

  return {
    figma: {
      fileKey: config.figma.fileKey,
      apiTokenEnv: config.figma.apiTokenEnv ?? "FIGMA_API_TOKEN",
      source: config.figma.source ?? "auto",
      teamId: config.figma.teamId ?? "",
    },
    codebase: {
      path: config.codebase.path,
      source: config.codebase.source ?? "auto",
    },
    modeName: config.modeName ?? null,
    nameMapping: config.nameMapping ?? {},
  };
}
