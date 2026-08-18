import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTokens } from "../src/diff.js";
import { buildReport, type ReportMeta } from "../src/report.js";
import type { Token } from "../src/types.js";

const meta: ReportMeta = {
  fileKey: "abc123",
  figmaSource: "variables",
  codebaseSource: "tailwind",
  figmaTokenCount: 2,
  codeTokenCount: 2,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

test("clean report states no drift and shows counts", () => {
  const report = buildReport(diffTokens([], [], {}), meta);
  assert.match(report, /No drift detected/);
  assert.match(report, /Checked \*\*2\*\* Figma tokens/);
  assert.match(report, /2\*\* codebase tokens/);
  assert.doesNotMatch(report, /Summary/);
});

test("drift report includes all three sections and totals", () => {
  const figmaTokens: Token[] = [
    { name: "color/primary", category: "color", value: "#FF0000" },
    { name: "color/only-figma", category: "color", value: "#00FF00" },
  ];
  const codeTokens: Token[] = [
    { name: "color/primary", category: "color", value: "#0000FF" },
    { name: "color/only-code", category: "color", value: "#FFFF00" },
  ];
  const report = buildReport(diffTokens(figmaTokens, codeTokens, {}), meta);

  assert.match(report, /### Value mismatches/);
  assert.match(report, /### Missing in code/);
  assert.match(report, /### Missing in Figma/);
  assert.match(report, /\| \*\*Total drift\*\* \| \*\*3\*\* \|/);
  assert.match(report, /`color\/primary`/);
  assert.match(report, /#FF0000/);
  assert.match(report, /#0000FF/);
});

test("sections are omitted when empty", () => {
  const report = buildReport(diffTokens([{ name: "a", category: "color", value: "1" }], [], {}), meta);
  assert.match(report, /### Missing in code/);
  assert.doesNotMatch(report, /### Value mismatches/);
  assert.doesNotMatch(report, /### Missing in Figma/);
});

test("pipe and newline characters are escaped in table cells", () => {
  const report = buildReport(
    diffTokens(
      [{ name: "color|weird\nname", category: "color", value: "a|b" }],
      [{ name: "color|weird\nname", category: "color", value: "c|d" }],
      {},
    ),
    meta,
  );
  assert.match(report, /color\\|weird/);
  assert.doesNotMatch(report, /color\|weird(?!\\|\|)/);
});
