import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { initAgentRules, installHook } from "../src/hooks.js";
import { scratchProject } from "./helpers.js";

test("install-hook refuses to clobber an existing hook without confirmation", async () => {
  const scratch = scratchProject();
  try {
    const hooks = join(scratch.dir, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho existing\n");

    const blocked = await installHook(scratch.dir, async () => false);
    assert.equal(blocked.installed, false);
    assert.match(readFileSync(hook, "utf8"), /echo existing/);

    const replaced = await installHook(scratch.dir, async () => true);
    assert.equal(replaced.installed, true);
    assert.match(readFileSync(hook, "utf8"), /elf-watch lint --strict/);
  } finally {
    scratch.cleanup();
  }
});

test("install-hook creates a hook when none exists", async () => {
  const scratch = scratchProject();
  try {
    mkdirSync(join(scratch.dir, ".git"), { recursive: true });
    const result = await installHook(scratch.dir, async () => false);
    assert.equal(result.installed, true);
    assert.ok(existsSync(result.path));
  } finally {
    scratch.cleanup();
  }
});

test("init-agent-rules creates both files and appends only once", () => {
  const scratch = scratchProject();
  try {
    mkdirSync(join(scratch.dir, ".git"), { recursive: true });
    const first = initAgentRules(scratch.dir);
    assert.equal(first.cursor, "created");
    assert.equal(first.agents, "created");
    assert.match(
      readFileSync(join(scratch.dir, ".cursor", "rules", "design-system.mdc"), "utf8"),
      /Use design tokens only/,
    );

    const second = initAgentRules(scratch.dir);
    assert.equal(second.cursor, "exists");
    assert.equal(second.agents, "exists");
    const agents = readFileSync(join(scratch.dir, "AGENTS.md"), "utf8");
    assert.equal(agents.match(/<!-- elf-watch:start -->/g)?.length, 1);
  } finally {
    scratch.cleanup();
  }
});
