import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTokens } from "../src/core/diff.js";
import type { Token } from "../src/core/types.js";

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


test('CSS RGB numbers and percentages normalize to the same color as Figma channels',async()=>{
 const {cssColorToHex,rgbToHex}=await import('../src/core/normalize.js');
 assert.equal(cssColorToHex('rgb(111, 60, 250)'),'#6f3cfa');
 assert.equal(cssColorToHex('rgba(111.00000098347664,60.00000022351742,250.00000029802322,1)'),'#6f3cfa');
 assert.equal(cssColorToHex('rgb(100% 0% 50% / 50%)'),'#ff008080');
 assert.equal(cssColorToHex('rgba(0, 128, 255, 0.5)'),'#0080ff80');
 assert.equal(cssColorToHex('rgb(0 0 0)'),'#000000');
 assert.equal(cssColorToHex('rgb(255 255 255)'),'#ffffff');
 assert.equal(cssColorToHex('rgb(NaN 0 0)'),null);
 assert.equal(cssColorToHex('rgba(0, 0, 0, nope)'),null);
 const actual=rgbToHex(0.43529412150382996,0.23529411852359772,0.9803921580314636);
 assert.equal(cssColorToHex('rgb(111 60 250)'),actual);
});

test('post-write color verification accepts Figma float precision but refuses a different paint',async()=>{
 const {verifyComponentPatch}=await import('../src/verify-write.js');
 const node={fills:[{color:{r:0.43529412150382996,g:0.23529411852359772,b:0.9803921580314636},opacity:1}]};
 assert.doesNotThrow(()=>verifyComponentPatch({fill:{color:'#6f3cfa'}},node,[],[]));
 assert.throws(()=>verifyComponentPatch({fill:{color:'#ffffff'}},node,[],[]),/could not be verified/);
 assert.throws(()=>verifyComponentPatch({fill:{color:'#6f3cfa80'}},node,[],[]),/could not be verified/);
});
