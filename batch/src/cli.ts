import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBridgeClient } from "../../mcp/src/client.js";
import { loadDotEnvFile } from "../../mcp/src/config.js";
import { CONFIG_FILE, loadConfig } from "./config.js";
import { runSync, type SyncResult } from "./sync.js";

export interface CliOptions {
  configPath: string;
  dryRun: boolean;
  only?: string;
  chunkSize?: number;
  force: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { configPath: CONFIG_FILE, dryRun: false, force: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = (name: string): string => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value.`);
      index += 1;
      return next;
    };

    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--config") options.configPath = value("--config");
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--only") options.only = value("--only");
    else if (arg.startsWith("--only=")) options.only = arg.slice("--only=".length);
    else if (arg === "--force") options.force = true;
    else if (arg === "--resume") {
      // The default; accepted so scripts can be explicit.
    } else if (arg === "--chunk") {
      options.chunkSize = parseChunk(value("--chunk"));
    } else if (arg.startsWith("--chunk=")) {
      options.chunkSize = parseChunk(arg.slice("--chunk=".length));
    } else {
      throw new Error(`Unknown option "${arg}".`);
    }
  }

  return options;
}

function parseChunk(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--chunk must be a positive integer (got "${raw}").`);
  return value;
}

export function usage(): string {
  return [
    "elf-batch — push a component library into Figma through the Elf bridge.",
    "",
    "Usage: elf-batch [options]",
    "",
    "Options:",
    `  --config <path>   Config file (default: ${CONFIG_FILE})`,
    "  --dry-run         Print the plan; nothing is written and no bridge call is made",
    "  --only <name>     Only this component (or codeKey) plus its dependencies",
    "  --chunk <n>       Components per chunk (default: the config's chunkSize)",
    "  --resume          Skip unchanged components (the default)",
    "  --force           Ignore hashes: re-sync everything",
    "  --help            Show this help",
    "",
    "See batch/README.md for the config, tokens and sidecar formats.",
    "",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`elf-batch: ${(error as Error).message}`);
    console.error(usage());
    return 1;
  }

  if (options.help) {
    console.log(usage());
    return 0;
  }

  // The bridge reads the same mcp/.env as the MCP server; shell env wins.
  const here = dirname(fileURLToPath(import.meta.url));
  loadDotEnvFile(resolve(here, "../../mcp/.env"));

  let config;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    console.error(`elf-batch: ${(error as Error).message}`);
    return 1;
  }

  const client = options.dryRun ? null : await connectOrReport();
  if (!options.dryRun && client === null) return 1;

  try {
    const result = await runSync({
      config,
      client,
      force: options.force,
      only: options.only,
      chunkSize: options.chunkSize,
    });
    report(result);
    if (result.aborted) return 1;
    return result.components.some((outcome) => outcome.action === "failed") ? 1 : 0;
  } catch (error) {
    // Config/sidecar/graph problems: the message is the whole story.
    console.error(`elf-batch: ${(error as Error).message}`);
    return 1;
  } finally {
    client?.close();
  }
}

async function connectOrReport() {
  try {
    return await createBridgeClient();
  } catch (error) {
    console.error(`elf-batch: ${(error as Error).message}`);
    return null;
  }
}

function report(result: SyncResult): void {
  const { tokens, components } = result;
  if (result.aborted) {
    console.error(`elf-batch: ${result.aborted}`);
    console.error("Nothing else was attempted. Fix the problem and re-run — resume is automatic.");
    return;
  }

  if (result.dryRun) console.log("");
  console.log(
    `tokens: ${tokens.primitives.planned} primitives (${tokens.primitives.upserted} upserted, ` +
      `${tokens.primitives.unchanged} unchanged), ${tokens.semantic.planned} semantic ` +
      `(${tokens.semantic.upserted} upserted, ${tokens.semantic.unchanged} unchanged), ` +
      `${tokens.textStyles} text styles, ${tokens.effectStyles} effect styles`,
  );

  const count = (action: string): number => components.filter((outcome) => outcome.action === action).length;
  if (result.dryRun) {
    console.log(
      `components (leaves first): ${count("synced")} would sync, ${count("unchanged")} unchanged, ` +
        `${count("failed")} failed, ${count("skipped")} skipped`,
    );
  } else {
    const created = components.filter((outcome) => outcome.action === "synced" && outcome.created).length;
    const updated = count("synced") - created;
    console.log(
      `components (leaves first): ${count("synced")} synced (${created} created, ${updated} updated), ` +
        `${count("unchanged")} unchanged, ${count("failed")} failed, ${count("skipped")} skipped`,
    );
  }

  for (const outcome of components) {
    if (outcome.action === "failed") console.error(`  ✗ ${outcome.file} — ${outcome.error ?? "unknown error"}`);
    if (outcome.action === "skipped") console.error(`  ⊘ ${outcome.file} — ${outcome.error ?? "skipped"}`);
  }

  if (result.dryRun) console.log("dry run — nothing was written");
}
