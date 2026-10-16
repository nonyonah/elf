import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { parseComponents } from "../src/parser.js";
import { FIXTURE_COMPONENTS, FIXTURE_CYCLE } from "./helpers.js";

describe("parser", () => {
  const parsed = parseComponents(FIXTURE_COMPONENTS);
  const byName = new Map(parsed.map((component) => [component.name, component]));

  test("finds every component, whatever the framework", () => {
    assert.deepEqual(
      parsed.map((component) => component.name),
      ["Alert", "Badge", "Button", "Card", "Divider", "Footer", "Icon", "Status"],
    );
  });

  test("codeKey is the relative path plus the component name", () => {
    assert.equal(byName.get("Button")?.codeKey, "Button.tsx#Button");
    assert.equal(byName.get("Badge")?.codeKey, "Badge.vue#Badge");
    assert.equal(byName.get("Status")?.codeKey, "Status.svelte#Status");
    assert.equal(byName.get("Divider")?.codeKey, "Divider.jsx#Divider");
    assert.equal(byName.get("Footer")?.codeKey, "Footer.astro#Footer");
  });

  test("reads string-literal unions off the props type, in order", () => {
    assert.deepEqual(byName.get("Button")?.variantProps, [
      { name: "size", values: ["sm", "md"] },
      { name: "intent", values: ["primary", "secondary"] },
    ]);
    assert.deepEqual(byName.get("Alert")?.variantProps, [{ name: "tone", values: ["info", "danger"] }]);
    assert.deepEqual(byName.get("Status")?.variantProps, [
      { name: "tone", values: ["positive", "negative"] },
    ]);
  });

  test("components without variant props parse as plain", () => {
    for (const name of ["Icon", "Divider", "Badge", "Card", "Footer"]) {
      assert.deepEqual(byName.get(name)?.variantProps, [], `${name} must have no variant props`);
    }
  });

  test("imports become dependencies — across frameworks, extensionless included", () => {
    assert.deepEqual(byName.get("Button")?.dependencies, ["Icon.tsx#Icon"]);
    assert.deepEqual(byName.get("Alert")?.dependencies, ["Icon.tsx#Icon"]);
    assert.deepEqual(byName.get("Card")?.dependencies, ["Badge.vue#Badge"]);
    assert.deepEqual(byName.get("Footer")?.dependencies, ["Divider.jsx#Divider"]);
  });

  test("leaves have no dependencies", () => {
    for (const name of ["Icon", "Divider", "Badge", "Status"]) {
      assert.deepEqual(byName.get(name)?.dependencies, [], `${name} must have no dependencies`);
    }
  });

  test("a mutual import parses to mutual dependencies", () => {
    const cycle = parseComponents(FIXTURE_CYCLE);
    const a = cycle.find((component) => component.name === "A");
    const b = cycle.find((component) => component.name === "B");
    assert.deepEqual(a?.dependencies, ["B.tsx#B"]);
    assert.deepEqual(b?.dependencies, ["A.tsx#A"]);
  });

  describe("script flavors", () => {
    const dir = mkdtempSync(join(tmpdir(), "elf-parser-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const parseOne = (file: string, source: string) => {
      writeFileSync(join(dir, file), source);
      const [component] = parseComponents(dir);
      rmSync(join(dir, file));
      return component;
    };

    test("Vue inline defineProps<{ … }>() type literals become variant props", () => {
      const component = parseOne(
        "Widget.vue",
        `<script setup lang="ts">
defineProps<{ size?: "sm" | "lg" }>();
</script>
<template><div /></template>
`,
      );
      assert.deepEqual(component?.variantProps, [{ name: "size", values: ["sm", "lg"] }]);
    });

    test("Svelte 4 export let declarations become variant props", () => {
      const component = parseOne(
        "Toggle.svelte",
        `<script lang="ts">
  export let tone: "on" | "off" = "on";
  export let label: string;
</script>
<button>{label}</button>
`,
      );
      assert.deepEqual(component?.variantProps, [{ name: "tone", values: ["on", "off"] }]);
    });

    test("re-exports count as dependencies too", () => {
      writeFileSync(join(dir, "Inner.tsx"), "export default function Inner() { return <div />; }\n");
      writeFileSync(join(dir, "Outer.tsx"), `export { default } from "./Inner";\n`);
      const outer = parseComponents(dir).find((component) => component.name === "Outer");
      assert.deepEqual(outer?.dependencies, ["Inner.tsx#Inner"]);
      rmSync(join(dir, "Inner.tsx"));
      rmSync(join(dir, "Outer.tsx"));
    });
  });
});
