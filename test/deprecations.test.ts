import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDeprecations } from "../src/core/deprecations.js";
import { diffTokens, type DriftResult } from "../src/core/diff.js";
import type { Token } from "../src/core/types.js";

const TODAY = "2026-06-01";

function token(name: string, value = "#111111"): Token {
  return { name, category: "color", value, source: "code" };
}

function base(missingFromFigma: Token[]): DriftResult {
  return diffTokens([], missingFromFigma, {});
}

test("a deprecated token missing from Figma is informational, not drift", () => {
  const codeTokens = [token("color/legacy")];
  const result = applyDeprecations(
    base(codeTokens),
    [{ name: "color/legacy", type: "token", reason: "replaced by color/primary", since: "2026-01-01" }],
    { codeTokens, codeComponents: [] },
    TODAY,
  );

  assert.equal(result.driftFound, false);
  assert.equal(result.missingInFigma.length, 0);
  assert.equal(result.deprecatedStillInCode.length, 1);
  assert.equal(result.deprecatedStillInCode[0]?.kind, "token");
  assert.match(result.deprecatedStillInCode[0]?.detail ?? "", /replaced by color\/primary/);
  assert.match(result.deprecatedStillInCode[0]?.detail ?? "", /still in code as `#111111`/);
});

test("an overdue deprecation counts as drift", () => {
  const codeTokens = [token("color/legacy")];
  const result = applyDeprecations(
    base(codeTokens),
    [{ name: "color/legacy", type: "token", removeBy: "2026-05-31" }],
    { codeTokens, codeComponents: [] },
    TODAY,
  );

  assert.equal(result.driftFound, true);
  assert.equal(result.missingInFigma.length, 0);
  assert.equal(result.deprecatedStillInCode.length, 0);
  assert.equal(result.deprecationOverdue.length, 1);
  assert.match(result.deprecationOverdue[0]?.detail ?? "", /remove by 2026-05-31/);
});

test("removeBy on today's date is not overdue yet", () => {
  const codeTokens = [token("color/legacy")];
  const result = applyDeprecations(
    base(codeTokens),
    [{ name: "color/legacy", type: "token", removeBy: TODAY }],
    { codeTokens, codeComponents: [] },
    TODAY,
  );

  assert.equal(result.deprecationOverdue.length, 0);
  assert.equal(result.deprecatedStillInCode.length, 1);
  assert.equal(result.driftFound, false);
});

test("a deprecated token gone from the code is safe to remove from the list", () => {
  const result = applyDeprecations(
    base([]),
    [{ name: "color/legacy", type: "token", reason: "was replaced" }],
    { codeTokens: [], codeComponents: [] },
    TODAY,
  );

  assert.equal(result.driftFound, false);
  assert.equal(result.safeToRemoveFromDeprecations.length, 1);
  assert.equal(result.safeToRemoveFromDeprecations[0]?.kind, "token");
  assert.equal(result.deprecatedStillInCode.length, 0);
});

test("a deprecated token on both sides is a live deprecation and silent", () => {
  const existing = token("color/legacy");
  const result = applyDeprecations(
    diffTokens([existing], [existing], {}),
    [{ name: "color/legacy", type: "token" }],
    { codeTokens: [existing], codeComponents: [] },
    TODAY,
  );

  assert.equal(result.driftFound, false);
  assert.equal(result.deprecatedStillInCode.length, 0);
  assert.equal(result.safeToRemoveFromDeprecations.length, 0);
  assert.equal(result.missingInFigma.length, 0);
});

test("deprecated components move out of the component bucket, by name or codeKey", () => {
  const codeComponents = [
    { name: "LegacyButton", codeKey: "LegacyButton.tsx#LegacyButton" },
    { name: "LegacyCard", codeKey: "LegacyCard.tsx#LegacyCard" },
  ];
  const result = base([]);
  result.componentsInCodeNotInFigma.push(
    { name: "LegacyButton", codeKey: "LegacyButton.tsx#LegacyButton", file: "LegacyButton.tsx" },
    { name: "LegacyCard", codeKey: "LegacyCard.tsx#LegacyCard", file: "LegacyCard.tsx" },
  );
  result.driftFound = true;

  const updated = applyDeprecations(
    result,
    [
      { name: "LegacyButton", type: "component", reason: "replaced by Button" },
      { name: "LegacyCard.tsx#LegacyCard", type: "component", removeBy: "2026-05-01" },
    ],
    { codeTokens: [], codeComponents },
    TODAY,
  );

  assert.equal(updated.componentsInCodeNotInFigma.length, 0);
  assert.deepEqual(updated.deprecatedStillInCode.map((item) => item.name), ["LegacyButton"]);
  assert.equal(updated.deprecatedStillInCode[0]?.kind, "component");
  assert.match(updated.deprecatedStillInCode[0]?.detail ?? "", /still in LegacyButton.tsx/);
  assert.deepEqual(updated.deprecationOverdue.map((item) => item.name), ["LegacyCard"]);
  assert.equal(updated.driftFound, true, "the overdue component keeps drifting");
});

test("a deprecated component gone from the code is safe to remove from the list", () => {
  const result = applyDeprecations(
    base([]),
    [{ name: "LegacyButton", type: "component" }],
    { codeTokens: [], codeComponents: [] },
    TODAY,
  );

  assert.equal(result.safeToRemoveFromDeprecations.length, 1);
  assert.equal(result.safeToRemoveFromDeprecations[0]?.kind, "component");
});

test("an empty deprecations list changes nothing", () => {
  const result = base([token("color/only-code")]);
  const updated = applyDeprecations(result, [], { codeTokens: [], codeComponents: [] }, TODAY);
  assert.equal(updated, result, "same object, no recomputation");
});
