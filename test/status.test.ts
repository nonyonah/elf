import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDeprecations } from "../src/deprecations.js";
import { diffTokens } from "../src/diff.js";
import { buildReport, buildStatusPayload, type ReportMeta } from "../src/report.js";
import type { Token } from "../src/types.js";

const meta: ReportMeta = {
  fileKey: "abc123",
  figmaSource: "variables (bridge)",
  codebaseSource: "tailwind",
  figmaTokenCount: 3,
  codeTokenCount: 2,
  checkedAt: "2026-06-01T00:00:00.000Z",
};

const token = (name: string, value: string, mode?: string): Token => ({
  name,
  category: "color",
  value,
  ...(mode === undefined ? {} : { mode }),
});

test("the status payload keeps every legacy key and adds the new ones", () => {
  const result = diffTokens(
    [token("a", "1"), token("c", "5")],
    [token("a", "2"), token("b", "3")],
    {},
  );
  const payload = buildStatusPayload(result);

  // Legacy keys — downstream workflows and dashboards depend on these.
  assert.equal(payload.driftFound, true);
  assert.equal(payload.valueMismatches, 1);
  assert.equal(payload.missingInCode, 1);
  assert.equal(payload.missingInFigma, 1);

  // Phase C additions, all present even when empty.
  for (const key of [
    "componentsOutOfDate",
    "componentsChangedInFigma",
    "componentsInCodeNotInFigma",
    "componentsInFigmaNotInCode",
    "deprecatedStillInCode",
    "deprecationOverdue",
    "safeToRemoveFromDeprecations",
  ]) {
    assert.equal(payload[key], 0, `${key} defaults to 0`);
  }
});

test("the status payload counts every new category", () => {
  const result = diffTokens([], [], {});
  result.componentsOutOfDate.push({ name: "A" });
  result.componentsChangedInFigma.push({ name: "B" });
  result.componentsInCodeNotInFigma.push({ name: "C" }, { name: "D" });
  result.componentsInFigmaNotInCode.push({ name: "E" });
  result.deprecatedStillInCode.push({ kind: "token", name: "F" });
  result.deprecationOverdue.push({ kind: "component", name: "G" });
  result.safeToRemoveFromDeprecations.push({ kind: "token", name: "H" });

  const payload = buildStatusPayload(result);
  assert.equal(payload.componentsOutOfDate, 1);
  assert.equal(payload.componentsChangedInFigma, 1);
  assert.equal(payload.componentsInCodeNotInFigma, 2);
  assert.equal(payload.componentsInFigmaNotInCode, 1);
  assert.equal(payload.deprecatedStillInCode, 1);
  assert.equal(payload.deprecationOverdue, 1);
  assert.equal(payload.safeToRemoveFromDeprecations, 1);
});

test("multi-mode mismatches carry the mode label in the report", () => {
  const result = diffTokens(
    [token("color/bg", "#FFFFFF", "Light"), token("color/bg", "#000000", "Dark")],
    [token("color/bg", "#EEEEEE")],
    {},
  );

  assert.equal(result.valueMismatches.length, 2);
  const report = buildReport(result, meta);
  assert.match(report, /`color\/bg` \(Light\)/);
  assert.match(report, /`color\/bg` \(Dark\)/);
});

test("component sections render with codeKey and detail", () => {
  const result = diffTokens([], [], {});
  result.componentsOutOfDate.push({
    name: "Card",
    codeKey: "Card.vue#Card",
    file: "Card.vue",
    detail: "the code spec changed — re-run elf-batch",
  });
  result.driftFound = true;

  const report = buildReport(result, meta);
  assert.match(report, /### Components out of date/);
  assert.match(report, /`Card` \| `Card\.vue#Card`/);
  assert.match(report, /\| \*\*Total drift\*\* \| \*\*1\*\* \|/);
});

test("deprecation sections render, and safe removals show on a clean check", () => {
  const clean = applyDeprecations(
    diffTokens([], [], {}),
    [{ name: "color/legacy", type: "token", reason: "superseded" }],
    { codeTokens: [], codeComponents: [] },
    "2026-06-01",
  );

  const report = buildReport(clean, meta);
  assert.match(report, /No drift detected/);
  assert.match(report, /### Safe to remove from the deprecations list/);
  assert.match(report, /`color\/legacy`/);

  const drifting = applyDeprecations(
    diffTokens([], [token("color/legacy", "#123456")], {}),
    [{ name: "color/legacy", type: "token", removeBy: "2026-01-01" }],
    { codeTokens: [token("color/legacy", "#123456")], codeComponents: [] },
    "2026-06-01",
  );
  const overdueReport = buildReport(drifting, meta);
  assert.match(overdueReport, /### Deprecation overdue/);
  assert.match(overdueReport, /remove by 2026-01-01/);
});

test("the Missing in Figma section explains the new-in-code case", () => {
  const report = buildReport(diffTokens([], [token("color/new", "#FF00FF")], {}), meta);
  assert.match(report, /New in code: never in Figma, or removed from Figma without being marked deprecated\./);
});
