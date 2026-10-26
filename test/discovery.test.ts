import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { discoverProject } from "../src/discovery.js";
import { loadConfig } from "../src/config.js";
import { parseProjectTokens } from "../src/codebase/index.js";
import { parseComponents } from "../batch/src/parser.js";

function scratch() {
  const root = mkdtempSync(join(tmpdir(), "elf-discovery-"));
  const file = (path: string, source: string) => { const target = join(root, path); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, source); return target; };
  const config = file("elf.config.json", JSON.stringify({figma: {fileKey: "discovery"}, codebase: {path: "auto", source: "auto"}}));
  return {root, file, config, cleanup: () => rmSync(root, {recursive: true, force: true})};
}
const component = "export function Button() { return <button>Save</button>; }";

test("discovery finds multiple source trees while excluding dependencies, test files, ignored paths and symlinks", () => {
  const p = scratch(); const external = scratch();
  try {
    p.file("packages/web/components/Button.tsx", component);
    p.file("packages/mobile/ui/Card.vue", "<template><div /></template>");
    p.file("src/theme/colors.css", ":root { --color-primary: #112233; }");
    p.file("design/tokens/spacing.json", '{"spacing":{"small":{"$type":"dimension","$value":"4px"}}}');
    for (const path of ["node_modules/lib/Button.tsx", "dist/Button.tsx", "test/Button.tsx", "fixtures/Button.tsx", "src/components/Button.test.tsx", "src/components/Button.stories.tsx", "cache-output/Button.tsx", "src/generated/Auto.tsx"]) p.file(path, component);
    p.file(".gitignore", "cache-*\nsrc/generated/\n");
    external.file("Secret.tsx", component);
    symlinkSync(external.root, join(p.root, "linked"));
    const result = discoverProject(p.root);
    assert.equal(result.components.length, 2);
    assert.equal(result.tokens.length, 2);
    const config = loadConfig(p.config);
    const parsed = parseComponents(config.components!.path, config.components!.files);
    assert.deepEqual(parsed.map(item => item.codeKey).sort(), ["packages/mobile/ui/Card.vue#Card", "packages/web/components/Button.tsx#Button"]);
  } finally {p.cleanup(); external.cleanup();}
});

test("new folders are discovered and existing component identities stay stable", () => {
  const p = scratch();
  try {
    p.file("src/components/Button.tsx", component);
    const before = loadConfig(p.config);
    const key = parseComponents(before.components!.path, before.components!.files)[0]!.codeKey;
    p.file("packages/extra/Card.tsx", "export function Card() { return <div />; }");
    const after = loadConfig(p.config);
    const parsed = parseComponents(after.components!.path, after.components!.files);
    assert.equal(parsed.length, 2);
    assert.equal(parsed.find(item => item.name === "Button")!.codeKey, key);
  } finally {p.cleanup();}
});

test("automatic token sources merge files and report conflicting values", async () => {
  const p = scratch();
  try {
    p.file("styles/colors.css", ":root { --color-primary: #112233; }");
    p.file("styles/spacing.css", "@theme { --spacing-small: 4px; }");
    const tokens = await parseProjectTokens(loadConfig(p.config).codebase);
    assert.equal(tokens.length, 2);
    p.file("styles/duplicate.css", ":root { --color-primary: #abcdef; }");
    await assert.rejects(parseProjectTokens(loadConfig(p.config).codebase), /Conflicting token/);
  } finally {p.cleanup();}
});

test("automatic Tailwind detection reads literal themes without executing project code", async () => {
  const p = scratch();
  try {
    p.file("tailwind.config.ts", 'throw new Error("MUST NOT EXECUTE"); const color = "#112233"; export default {plugins: [unknownPlugin()], theme: {extend: {colors: {primary: color}, spacing: {small: "4px"}}}};');
    const tokens = await parseProjectTokens(loadConfig(p.config).codebase);
    assert.equal(tokens.length, 2);
    assert.equal(tokens.find(item => item.name === "primary")?.value, "#112233");
    p.file("tailwind.config.ts", 'export default {theme: {colors: loadSecretColors()}};');
    await assert.rejects(parseProjectTokens(loadConfig(p.config).codebase), /cannot be discovered safely/);
  } finally {p.cleanup();}
});

test("empty projects can onboard and discover resources added later", async () => {
  const p = scratch();
  try {
    assert.deepEqual(await parseProjectTokens(loadConfig(p.config).codebase), []);
    assert.equal(loadConfig(p.config).components, undefined);
    p.file("tokens.css", ":root { --radius-small: 4px; }");
    assert.equal((await parseProjectTokens(loadConfig(p.config).codebase)).length, 1);
  } finally {p.cleanup();}
});

test("discovery supports JSX in JavaScript and flat theme JSON", async () => {
  const p = scratch();
  try {
    p.file("ui/Button.js", component);
    p.file("ui/helpers.js", "export const label = \"Save\";");
    p.file("theme.json", '{"primary":"#112233"}');
    const config = loadConfig(p.config);
    assert.equal(parseComponents(config.components!.path, config.components!.files)[0]?.name, "Button");
    assert.equal(parseComponents(join(p.root, "ui")).length, 1);
    assert.equal((await parseProjectTokens(config.codebase))[0]?.value, "#112233");
    p.file("theme.json", '{"primary":');
    assert.equal(discoverProject(p.root).tokens.length, 1);
    await assert.rejects(parseProjectTokens(loadConfig(p.config).codebase));
  } finally {p.cleanup();}
});

test("nested ignore rules can explicitly reinclude a component", () => {
  const p = scratch();
  try {
    p.file(".gitignore", "*.tsx\n");
    p.file("src/components/.gitignore", "!Button.tsx\n");
    p.file("src/components/Button.tsx", component);
    p.file("src/components/Other.tsx", component);
    assert.equal(discoverProject(p.root).components.length, 1);
  } finally {p.cleanup();}
});
