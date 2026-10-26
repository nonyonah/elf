import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { scratchProject } from "./helpers.js";

test("--help prints usage and exits 0", async () => {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await main(["--help"]), 0);
    assert.match(output, /elf-watch/);
  } finally {
    process.stdout.write = original;
  }
});

test("unknown options fail with exit 1", async () => {
  const original = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal(await main(["--not-a-flag"]), 1);
  } finally {
    process.stderr.write = original;
  }
});

test("init-agent-rules writes into the configured project", async () => {
  const scratch = scratchProject();
  const original = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    mkdirSync(join(scratch.dir, ".git"), { recursive: true });
    assert.equal(await main(["init-agent-rules", "--config", scratch.config.configPath]), 0);
    assert.ok(existsSync(join(scratch.dir, ".cursor", "rules", "design-system.mdc")));
    assert.ok(existsSync(join(scratch.dir, "AGENTS.md")));
  } finally {
    process.stdout.write = original;
    scratch.cleanup();
  }
});
