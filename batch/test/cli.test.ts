import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { main, parseArgs, usage } from "../src/cli.js";
import { FIXTURE_TOKENS, scratchFixtures } from "./helpers.js";

describe("cli", () => {
  test("defaults", () => {
    assert.deepEqual(parseArgs([]), {
      configPath: "elf-batch.config.json",
      dryRun: false,
      force: false,
    });
  });

  test("every flag parses, in --flag value and --flag=value form", () => {
    assert.deepEqual(parseArgs(["--config", "custom.json", "--dry-run", "--only", "Button", "--chunk", "2", "--force"]), {
      configPath: "custom.json",
      dryRun: true,
      only: "Button",
      chunkSize: 2,
      force: true,
    });
    assert.deepEqual(parseArgs(["--config=custom.json", "--only=Card.tsx#Card", "--chunk=3"]), {
      configPath: "custom.json",
      dryRun: false,
      only: "Card.tsx#Card",
      chunkSize: 3,
      force: false,
    });
    assert.equal(parseArgs(["--resume"]).dryRun, false, "--resume is accepted as the explicit default");
  });

  test("bad input fails with a message, not a stack", () => {
    assert.throws(() => parseArgs(["--bogus"]), /Unknown option "--bogus"/);
    assert.throws(() => parseArgs(["--chunk", "0"]), /--chunk must be a positive integer/);
    assert.throws(() => parseArgs(["--chunk"]), /--chunk needs a value/);
    assert.throws(() => parseArgs(["--only"]), /--only needs a value/);
  });

  test("usage documents every flag", () => {
    for (const flag of ["--config", "--dry-run", "--only", "--chunk", "--resume", "--force", "--help"]) {
      assert.ok(usage().includes(flag), `usage must mention ${flag}`);
    }
  });

  test("main --help exits 0 without touching the bridge or the config", async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      assert.equal(await main(["--help"]), 0);
    } finally {
      console.log = original;
    }
    assert.ok(logs.join("\n").includes("elf-batch"));
  });

  test("main reports a missing config and exits 1", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: string) => errors.push(line);
    try {
      assert.equal(await main(["--config", "/nonexistent/elf-batch.config.json", "--dry-run"]), 1);
    } finally {
      console.error = original;
    }
    assert.match(errors.join("\n"), /Config file not found/);
  });

  test("a dry run through main plans and writes nothing", async () => {
    const scratch = scratchFixtures();
    const configPath = join(scratch.dir, "elf-batch.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({ tokens: FIXTURE_TOKENS, components: scratch.componentsDir, manifest: "elf.manifest.json" }),
    );

    const logs: string[] = [];
    const original = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      assert.equal(await main(["--config", configPath, "--dry-run"]), 0);
    } finally {
      console.log = original;
    }

    const output = logs.join("\n");
    assert.match(output, /tokens: 8 primitives/);
    assert.match(output, /components \(leaves first\): 8 would sync/);
    assert.match(output, /dry run — nothing was written/);
    scratch.cleanup();
  });
});
