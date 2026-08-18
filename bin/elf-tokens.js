#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts");
const child = spawn(
  process.execPath,
  ["--import", require.resolve("tsx"), cliPath, ...process.argv.slice(2)],
  { stdio: "inherit" },
);

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`elf-tokens: failed to start: ${error.message}`);
  process.exit(1);
});
