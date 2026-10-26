import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadConfig as loadBatchConfig } from "../../batch/src/config.js";
import type { WatchConfig } from "./types.js";

export const BATCH_CONFIG_FILE = "elf-batch.config.json";

/** Walk up from the project folder to find elf-batch.config.json. */
export function findBatchConfig(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, BATCH_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up for the drift-check config; separate from the batch config. */
export function findCheckConfig(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, "elf.config.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadWatchConfig(options: {
  batchConfigPath?: string;
  checkConfigPath?: string;
  reportDir?: string;
} = {}): WatchConfig {
  const batchPath =
    options.batchConfigPath ??
    findBatchConfig() ??
    (() => {
      throw new Error(
        `No ${BATCH_CONFIG_FILE} found. Run elf-watch from a project with one, or pass --config <path>.`,
      );
    })();
  const batch = loadBatchConfig(batchPath);
  const checkConfigPath = options.checkConfigPath ?? findCheckConfig(batch.root);
  return {
    batch,
    checkConfigPath,
    reportDir: resolve(options.reportDir ?? batch.root),
  };
}
