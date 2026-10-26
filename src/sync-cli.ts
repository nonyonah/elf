import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { acquireBridge } from "../mcp/src/runtime.js";
import { loadRuntimeBridgeConfig } from "../mcp/src/config.js";
import { loadWatchEnv } from "../watch/src/bridge.js";
import { findConfigPath } from "./config.js";
import { ProjectService } from "./project.js";

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("elf sync — review and apply this project's Figma changes\n\nOptions:\n  --config <path>  Project elf.config.json\n  --dry-run        Review without writing\n  --yes            Apply the freshly printed plan without an interactive prompt\n  --automatic      Also enable supported automatic updates after review\n\nFigma conflicts require explicit review in Settings; --yes never overrides them.");
    return 0;
  }
  let configPath = findConfigPath() ?? resolve("elf.config.json");
  let dryRun = false; let yes = false; let automatic = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config" && argv[i + 1]) configPath = resolve(argv[++i]);
    else if (argv[i] === "--dry-run") dryRun = true;
    else if (argv[i] === "--yes") yes = true;
    else if (argv[i] === "--automatic") automatic = true;
    else throw new Error(`Unknown sync option: ${argv[i]}`);
  }
  loadWatchEnv(dirname(configPath));
  const runtime = await acquireBridge(loadRuntimeBridgeConfig(), { log: line => console.error(`elf: ${line}`) });
  try {
    const project = new ProjectService(configPath, runtime);
    const plan = await project.plan();
    console.log(JSON.stringify(plan, null, 2));
    if (dryRun) return 0;
    if (plan.issues.some(issue => issue.kind === "conflict")) throw new Error("Figma edits need review. Open Elf Settings to resolve the conflicts.");
    if (!yes) {
      if (!process.stdin.isTTY) throw new Error("Use --dry-run to inspect changes, or --yes to apply a fresh plan.");
      const input = createInterface({ input: process.stdin, output: process.stdout });
      try { if ((await input.question(`Apply ${plan.entries.length} changes${automatic ? " and enable automatic sync" : ""}? Type yes: `)).trim() !== "yes") return 0; }
      finally { input.close(); }
    }
    console.log(JSON.stringify(await project.apply(plan.id, { enableAuto: automatic }), null, 2));
    if (automatic) console.log("Run elf to keep watching this project with automatic sync enabled.");
    return 0;
  } finally { await runtime.close(); }
}
