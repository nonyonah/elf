import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const coreDir = fileURLToPath(new URL("../src/core", import.meta.url));

const files = readdirSync(coreDir).filter((name) => name.endsWith(".ts"));

/** Every module specifier a source file mentions: static, dynamic, or require. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

const read = (file: string): string => readFileSync(join(coreDir, file), "utf8");

test("the core is populated", () => {
  assert.ok(files.length >= 8, `expected the core modules, found ${files.length} file(s)`);
});

test("the core imports nothing outside itself", () => {
  for (const file of files) {
    for (const spec of specifiers(read(file))) {
      assert.ok(!isBuiltin(spec), `${file} imports the Node built-in "${spec}"`);
      assert.ok(spec.startsWith("./"), `${file} imports "${spec}" — the core is self-contained ("./" imports only)`);
    }
  }
});

test("the core uses no process, console, fetch, or require", () => {
  const banned: [RegExp, string][] = [
    [/\bprocess\s*\./, "process"],
    [/\bconsole\s*\./, "console"],
    [/\bfetch\s*\(/, "fetch"],
    [/\brequire\s*\(/, "require"],
  ];
  for (const file of files) {
    const source = read(file);
    for (const [pattern, label] of banned) {
      assert.ok(!pattern.test(source), `${file} uses ${label} — keep it in the CLI-side modules`);
    }
  }
});
