import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { planTokens } from "../src/tokens.js";
import { FIXTURE_TOKENS, fixtureConfig } from "./helpers.js";

describe("token planning", () => {
  const { plan, index } = planTokens(FIXTURE_TOKENS, fixtureConfig());

  test("primitives become a single-mode Value collection", () => {
    assert.equal(plan.primitives.collection, "Primitives");
    assert.deepEqual(plan.primitives.modes, ["Value"]);
    assert.equal(plan.primitives.variables.length, 8);
    const primary = plan.primitives.variables.find((variable) => variable.codeKey === "color.primary.500");
    assert.equal(primary?.name, "color/primary/500");
    assert.equal(primary?.type, "COLOR");
    assert.deepEqual(primary?.scopes, ["ALL_FILLS"]);
    assert.deepEqual(primary?.values, { Value: "#6366f1" });
  });

  test("dimension and font tokens get the right types and scopes", () => {
    const space = plan.primitives.variables.find((variable) => variable.codeKey === "space.4");
    assert.equal(space?.type, "FLOAT");
    assert.deepEqual(space?.scopes, ["WIDTH_HEIGHT", "GAP", "CORNER_RADIUS"]);
    const family = plan.primitives.variables.find((variable) => variable.codeKey === "fontFamily.sans");
    assert.equal(family?.type, "STRING");
    assert.deepEqual(family?.scopes, ["FONT_FAMILY"]);
  });

  test("semantic tokens use the collection modes and drop the prefix in Figma", () => {
    assert.equal(plan.semantic.collection, "Semantic");
    assert.deepEqual(plan.semantic.modes, ["Light", "Dark"]);
    assert.equal(plan.semantic.variables.length, 2);
    const surface = plan.semantic.variables.find((variable) => variable.codeKey === "semantic.color.surface");
    assert.equal(surface?.name, "color/surface");
    assert.deepEqual(surface?.values, {
      Light: { variable: "color/surface/base" },
      Dark: { variable: "color/onSurface/base" },
    });
    const text = plan.semantic.variables.find((variable) => variable.codeKey === "semantic.color.text");
    assert.deepEqual(text?.values, {
      Light: { variable: "color/onSurface/base" },
      Dark: { variable: "color/onSurface/base" },
    });
  });

  test("the collections strategy builds one Value collection per mode", () => {
    const { plan: split } = planTokens(FIXTURE_TOKENS, fixtureConfig({ modeStrategy: "collections" }));
    assert.equal(split.semanticCollections?.length, 2);
    const light = split.semanticCollections?.[0];
    assert.equal(light?.collection, "Semantic Light");
    assert.deepEqual(light?.variables[0]?.values, { Value: { variable: "color/surface/base" } });
    const dark = split.semanticCollections?.[1];
    assert.equal(dark?.collection, "Semantic Dark");
    assert.deepEqual(dark?.variables[0]?.values, { Value: { variable: "color/onSurface/base" } });
  });

  test("the collections strategy scopes semantic index names to the first mode", () => {
    const { index: split } = planTokens(FIXTURE_TOKENS, fixtureConfig({ modeStrategy: "collections" }));
    assert.equal(split.get("semantic.color.surface")?.name, "Semantic Light/color/surface");
    assert.equal(split.get("color.surface.base")?.name, "color/surface/base");
  });

  test("text and effect styles are planned from references to literals", () => {
    assert.equal(plan.textStyles.length, 1);
    assert.deepEqual(plan.textStyles[0], {
      key: "Body/Regular",
      params: {
        name: "Body/Regular",
        codeKey: "Body/Regular",
        fontFamily: "Inter",
        fontSize: 14,
        lineHeight: { percent: 150 },
      },
    });
    assert.equal(plan.effectStyles.length, 1);
    assert.equal(plan.effectStyles[0]?.key, "Elevation/1");
  });

  test("the index maps every primitive and semantic path", () => {
    assert.equal(index.get("color.primary.500")?.type, "COLOR");
    assert.equal(index.get("radius.md")?.literal, 12);
    assert.equal(index.get("semantic.color.text")?.literal, null);
    assert.equal(index.get("semantic.color.text")?.name, "color/text");
  });

  test("bad data fails with pointed messages", () => {
    const dir = mkdtempSync(join(tmpdir(), "elf-tokens-"));
    const write = (name: string, data: unknown): string => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(data));
      return path;
    };
    const config = fixtureConfig();

    assert.throws(
      () => planTokens(write("bad-type.json", { size: { value: 4, type: "spacing" } }), config),
      /type "spacing".*use one of/,
    );
    assert.throws(
      () => planTokens(write("bad-value.json", { color: { x: { value: true, type: "color" } } }), config),
      /color, so "value" must be a hex\/rgb\(\) string/,
    );
    assert.throws(
      () =>
        planTokens(
          write("bad-ref.json", { semantic: { color: { a: { value: "{color.nope}" } } }, color: { x: { value: "#fff", type: "color" } } }),
          config,
        ),
      /references "color.nope", which is not a known token path/,
    );
    assert.throws(
      () =>
        planTokens(
          write("bad-mode.json", {
            color: { x: { value: "#fff", type: "color" } },
            semantic: { color: { a: { value: "#000", modes: { Midnight: "#111" } } } },
          }),
          config,
        ),
      /sets mode "Midnight"/,
    );
    assert.throws(
      () =>
        planTokens(
          write("bad-style.json", { textStyles: { X: { fontSize: "{color.x}" } }, color: { x: { value: "#fff", type: "color" } } }),
          config,
        ),
      /needs a FLOAT token/,
    );

    rmSync(dir, { recursive: true, force: true });
  });
});
