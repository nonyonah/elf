import { resolve } from "node:path";
import { loadConfig as loadBatchConfig } from "../../batch/src/config.js";
import { loadConfig } from "../../src/config.js";
import { resolveNotifyWebhook } from "../../src/notify.js";
import { componentFiles, formatFinding, lintFiles } from "./lint.js";
import { findBatchConfig, loadWatchConfig } from "./config.js";
import { initAgentRules, installHook } from "./hooks.js";
import { startWatch } from "./watcher.js";

const USAGE = `elf-watch — keep Figma in sync while you code

Usage:
  elf-watch [options]                 Watch components and tokens
  elf-watch lint [files] [--strict]   Find hardcoded colors and sizes
  elf-watch install-hook              Install a pre-commit lint hook
  elf-watch init-agent-rules          Write Cursor + AGENTS.md design rules

Options:
  --config <path>         elf-batch.config.json (default: search upward)
  --check-config <path>   elf.config.json for drift checks (default: search upward)
  --report-dir <path>     Where drift-report.md is written (default: project root)
  --force-component <name>  Override a Figma-change conflict once (repeatable)
  --notify                Force Slack drift alerts (default: auto when configured)
  --no-notify             Disable Slack drift alerts
  --strict                lint exits 2 when it finds a hardcoded value
  --help                  Show this help
`;

interface Args {
  command: "watch" | "lint" | "install-hook" | "init-agent-rules";
  config?: string;
  checkConfig?: string;
  reportDir?: string;
  forceComponents: string[];
  notify?: boolean;
  strict: boolean;
  files: string[];
  help: boolean;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`elf-watch: ${(error as Error).message}\n`);
    return 1;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    if (args.command === "lint") return runLint(args);
    if (args.command === "install-hook") return await runInstallHook(args);
    if (args.command === "init-agent-rules") return runInitAgentRules(args);
    return await runWatch(args);
  } catch (error) {
    process.stderr.write(`elf-watch: ${(error as Error).message}\n`);
    return 1;
  }
}

function runLint(args: Args): number {
  const config = loadWatchConfig({
    batchConfigPath: args.config,
    checkConfigPath: args.checkConfig,
  });
  const files = args.files.length > 0 ? args.files.map((file) => resolve(file)) : componentFiles(config.batch);
  if (files.length === 0) {
    process.stdout.write("No component files found.\n");
    return 0;
  }

  const result = lintFiles(files, config.batch);
  for (const finding of result.findings) process.stdout.write(`${formatFinding(finding)}\n`);
  for (const error of result.errors) process.stderr.write(`elf-watch: ${error}\n`);

  if (result.errors.length > 0) return 1;
  if (result.findings.length === 0) {
    process.stdout.write(`No hardcoded colors or sizes in ${result.files} file(s).\n`);
    return 0;
  }
  process.stdout.write(
    `${result.findings.length} hardcoded value(s) in ${result.files} file(s).` +
      (args.strict ? " Failing because of --strict.\n" : "\n"),
  );
  return args.strict ? 2 : 0;
}

async function runInstallHook(args: Args): Promise<number> {
  const root = projectRoot(args.config);
  const result = await installHook(root);
  if (result.installed) {
    process.stdout.write(`Installed pre-commit hook at ${result.path}.\n`);
  } else {
    process.stdout.write(`${result.reason ?? "Hook not installed."} (${result.path})\n`);
  }
  return 0;
}

function runInitAgentRules(args: Args): number {
  const root = projectRoot(args.config);
  const result = initAgentRules(root);
  process.stdout.write(
    `Agent rules in ${result.root}: .cursor/rules/design-system.mdc ${result.cursor}, ` +
      `AGENTS.md ${result.agents}.\n`,
  );
  return 0;
}

async function runWatch(args: Args): Promise<number> {
  const config = loadWatchConfig({
    batchConfigPath: args.config,
    checkConfigPath: args.checkConfig,
    reportDir: args.reportDir,
  });
  if (!config.checkConfigPath) {
    process.stderr.write(
      "elf-watch: no elf.config.json found — syncs will run, but drift checks will fail until one exists.\n",
    );
  }

  const notify = resolveNotify(args.notify, config.checkConfigPath);
  const controller = startWatch({ config, forceComponents: args.forceComponents, notify });
  const shutdown = (): void => {
    void controller.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await controller.ready;
    await controller.done;
    return 0;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

/**
 * Slack alerts are on by default when the check config has a notify section
 * and a webhook is available. `--notify` forces them on with a warning when
 * no webhook is configured; `--no-notify` turns them off.
 */
function resolveNotify(requested: boolean | undefined, checkConfigPath: string | null): boolean {
  if (requested === false) return false;
  if (!checkConfigPath) {
    if (requested) process.stderr.write("elf-watch: --notify needs an elf.config.json (or --check-config).\n");
    return false;
  }
  try {
    const config = loadConfig(checkConfigPath);
    if (resolveNotifyWebhook(config.notify, checkConfigPath)) return true;
    if (requested) {
      process.stderr.write(
        "elf-watch: --notify is on, but no Slack webhook is configured; continuing without alerts.\n",
      );
    }
    return false;
  } catch (error) {
    if (requested) {
      process.stderr.write(`elf-watch: could not enable notifications: ${(error as Error).message}\n`);
    }
    return false;
  }
}

function projectRoot(configPath?: string): string {
  const batchPath = configPath ?? findBatchConfig();
  if (!batchPath) return process.cwd();
  return loadBatchConfig(batchPath).root;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "watch",
    forceComponents: [],
    notify: undefined,
    strict: false,
    files: [],
    help: false,
  };

  const first = argv[0];
  if (first === "lint" || first === "install-hook" || first === "init-agent-rules") {
    args.command = first;
    argv = argv.slice(1);
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--config") {
      args.config = requiredValue(argv, ++i, arg);
    } else if (arg.startsWith("--config=")) {
      args.config = arg.slice("--config=".length);
    } else if (arg === "--check-config") {
      args.checkConfig = requiredValue(argv, ++i, arg);
    } else if (arg.startsWith("--check-config=")) {
      args.checkConfig = arg.slice("--check-config=".length);
    } else if (arg === "--report-dir") {
      args.reportDir = requiredValue(argv, ++i, arg);
    } else if (arg.startsWith("--report-dir=")) {
      args.reportDir = arg.slice("--report-dir=".length);
    } else if (arg === "--force-component") {
      args.forceComponents.push(requiredValue(argv, ++i, arg));
    } else if (arg.startsWith("--force-component=")) {
      args.forceComponents.push(arg.slice("--force-component=".length));
    } else if (arg === "--notify") {
      args.notify = true;
    } else if (arg === "--no-notify") {
      args.notify = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}". See --help.`);
    } else if (args.command === "lint") {
      args.files.push(arg);
    } else {
      throw new Error(`Unexpected argument "${arg}". See --help.`);
    }
  }

  return args;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
  return value;
}
