#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commands = {
  start: ["src/start.ts", true],
  mcp: ["mcp/src/index.ts", false],
  bridge: ["watch/src/bridge-host.ts", true],
  sync: ["src/sync-cli.ts", true],
  watch: ["src/start.ts", true],
};
const requested = process.argv[2];
const route = requested === undefined ? commands.start : Object.hasOwn(commands, requested) ? commands[requested] : undefined;
const args = route ? process.argv.slice(3) : process.argv.slice(2);
const cliPath = join(root, route ? route[0] : "src/cli.ts");
const child = spawn(
  process.execPath,
  route?.[1]
    ? ["--import", require.resolve("tsx"), "--input-type=module", "--eval",
       "const { main } = await import(process.argv[1]); process.exitCode = await main(process.argv.slice(2));",
       cliPath, ...args]
    : ["--import", require.resolve("tsx"), cliPath, ...args],
  { stdio: "inherit" },
);

const forwardSignal = (signal) => { if (!child.killed) child.kill(signal); };
const onInterrupt = () => forwardSignal("SIGINT");
const onTerminate = () => forwardSignal("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);

child.on("exit", (code, signal) => {
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  process.exit(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
});

child.on("error", (error) => {
  console.error(`elf-tokens: failed to start: ${error.message}`);
  process.exit(1);
});
