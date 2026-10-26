import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const HOOK = `#!/bin/sh
# Installed by elf-watch. Remove this block to disable.
if [ -x node_modules/.bin/elf-watch ]; then
  exec node_modules/.bin/elf-watch lint --strict
fi
if [ -f watch/bin/elf-watch.mjs ]; then
  exec node watch/bin/elf-watch.mjs lint --strict
fi
exec npx --no-install elf-watch lint --strict
`;

const AGENT_START = "<!-- elf-watch:start -->";
const AGENT_END = "<!-- elf-watch:end -->";

const AGENT_RULES = `- Use design tokens only. Never hardcode colors, spacing, radii, or fonts.
- Every new component needs a \`.figma.json\` sidecar and typed variant props.
- Add variants through the existing component; do not copy-paste a new component.
- Run \`elf-watch lint\` before finishing.
- Do not edit \`tokens.json\` values without saying so.`;

const AGENT_SECTION = `${AGENT_START}
## Design system rules

${AGENT_RULES}
${AGENT_END}
`;

const CURSOR_RULES = `---
description: Elf design system rules
alwaysApply: true
---

# Design system

${AGENT_RULES}
`;

export type Confirm = (message: string) => Promise<boolean>;

/** Walk up from a project folder to the git worktree root. */
export function findGitRoot(startDir = process.cwd()): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function installHook(
  startDir: string,
  confirm: Confirm = defaultConfirm,
): Promise<{ installed: boolean; path: string; reason?: string }> {
  const root = findGitRoot(startDir);
  if (!root) throw new Error(`No git repository found from ${startDir}.`);

  const hookPath = join(root, ".git", "hooks", "pre-commit");
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes("elf-watch")) {
      return { installed: false, path: hookPath, reason: "elf-watch is already in this hook." };
    }
    const overwrite = await confirm(`A pre-commit hook already exists at ${hookPath}. Overwrite it?`);
    if (!overwrite) {
      return { installed: false, path: hookPath, reason: "Existing hook left untouched." };
    }
  }

  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, HOOK);
  chmodSync(hookPath, 0o755);
  return { installed: true, path: hookPath };
}

export function initAgentRules(startDir: string): {
  root: string;
  cursor: "created" | "exists";
  agents: "created" | "appended" | "exists";
} {
  const root = findGitRoot(startDir) ?? resolve(startDir);
  const cursorPath = join(root, ".cursor", "rules", "design-system.mdc");
  let cursor: "created" | "exists" = "exists";
  if (!existsSync(cursorPath)) {
    mkdirSync(dirname(cursorPath), { recursive: true });
    writeFileSync(cursorPath, CURSOR_RULES);
    cursor = "created";
  }

  const agentsPath = join(root, "AGENTS.md");
  let agents: "created" | "appended" | "exists" = "exists";
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, AGENT_SECTION);
    agents = "created";
  } else {
    const existing = readFileSync(agentsPath, "utf8");
    if (!existing.includes(AGENT_START)) {
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      writeFileSync(agentsPath, `${existing}${separator}${AGENT_SECTION}`);
      agents = "appended";
    }
  }

  return { root, cursor, agents };
}

async function defaultConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
