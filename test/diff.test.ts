import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTokens } from "../src/diff.js";
import type { Token } from "../src/types.js";

const figma: Token = { name: "color/primary", category: "color", value: "#FF0000" };
const code: Token = { name: "color/primary", category: "color", value: "#FF0000" };

test("identical token lists produce no drift", () => {
  const result = diffTokens([figma], [code], {});
  assert.equal(result.driftFound, false);
  assert.equal(result.valueMismatches.length, 0);
  assert.equal(result.missingInCode.length, 0);
  assert.equal(result.missingInFigma.length, 0);
});

test("empty inputs are clean", () => {
  const result = diffTokens([], [], {});
  assert.equal(result.driftFound, false);
});

test("same name with different value is a value mismatch", () => {
  const result = diffTokens([figma], [{ ...code, value: "#00FF00" }], {});
  assert.equal(result.driftFound, true);
  assert.equal(result.valueMismatches.length, 1);
  assert.deepEqual(result.valueMismatches[0], {
    name: "color/primary",
    category: "color",
    figmaValue: "#FF0000",
    codeValue: "#00FF00",
  });
});

test("token in Figma but not in code is missing in code", () => {
  const result = diffTokens([figma], [], {});
  assert.equal(result.driftFound, true);
  assert.equal(result.missingInCode.length, 1);
  assert.deepEqual(result.missingInCode[0], figma);
});

test("token in code but not in Figma is missing in Figma", () => {
  const result = diffTokens([], [code], {});
  assert.equal(result.driftFound, true);
  assert.equal(result.missingInFigma.length, 1);
  assert.deepEqual(result.missingInFigma[0], code);
});

test("nameMapping aligns tokens with different names", () => {
  const figmaToken: Token = { name: "color/primary", category: "color", value: "#FF0000" };
  const codeToken: Token = { name: "colors.primary", category: "color", value: "#FF0000" };
  const result = diffTokens([figmaToken], [codeToken], { "color/primary": "colors.primary" });
  assert.equal(result.driftFound, false);
});

test("nameMapping applies to mismatched values too", () => {
  const figmaToken: Token = { name: "color/primary", category: "color", value: "#FF0000" };
  const codeToken: Token = { name: "colors.primary", category: "color", value: "#00FF00" };
  const result = diffTokens([figmaToken], [codeToken], { "color/primary": "colors.primary" });
  assert.equal(result.valueMismatches.length, 1);
  assert.equal(result.valueMismatches[0].name, "colors.primary");
});

test("missing-on-both-sides and mismatches count independently", () => {
  const result = diffTokens(
    [
      { name: "a", category: "color", value: "1" },
      { name: "b", category: "color", value: "2" },
    ],
    [
      { name: "a", category: "color", value: "9" },
      { name: "c", category: "color", value: "3" },
    ],
    {},
  );
  assert.equal(result.valueMismatches.length, 1);
  assert.equal(result.missingInCode.length, 1);
  assert.equal(result.missingInFigma.length, 1);
  assert.equal(result.driftFound, true);
});

test("duplicate names collapse to a single comparison (last wins)", () => {
  const result = diffTokens(
    [
      { name: "dup", category: "color", value: "1" },
      { name: "dup", category: "color", value: "2" },
    ],
    [{ name: "dup", category: "color", value: "1" }],
    {},
  );
  assert.equal(result.valueMismatches.length, 1);
  assert.equal(result.valueMismatches[0].figmaValue, "2");
  assert.equal(result.missingInCode.length, 0);
});
