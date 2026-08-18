import type { DriftResult } from "./diff.js";

export interface ReportMeta {
  fileKey: string;
  figmaSource: string;
  codebaseSource: string;
  figmaTokenCount: number;
  codeTokenCount: number;
  checkedAt: string;
}

const escapeCell = (value: string): string =>
  value.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function buildReport(result: DriftResult, meta: ReportMeta): string {
  const { valueMismatches, missingInCode, missingInFigma } = result;
  const total = valueMismatches.length + missingInCode.length + missingInFigma.length;

  const lines: string[] = [
    "## Design token drift report",
    "",
    `Checked **${meta.figmaTokenCount}** Figma tokens (${meta.figmaSource}) against ` +
      `**${meta.codeTokenCount}** codebase tokens (${meta.codebaseSource}) ` +
      `at ${meta.checkedAt}.`,
  ];

  if (!result.driftFound) {
    lines.push("", "✅ **No drift detected.** Figma and codebase tokens are in agreement.");
    return lines.join("\n");
  }

  lines.push(
    "",
    "### Summary",
    "",
    "| Check | Count |",
    "|---|---|",
    `| Value mismatches (same name, different value) | ${valueMismatches.length} |`,
    `| Missing in code (in Figma, not in the codebase) | ${missingInCode.length} |`,
    `| Missing in Figma (in the codebase, not in Figma) | ${missingInFigma.length} |`,
    `| **Total drift** | **${total}** |`,
  );

  if (valueMismatches.length > 0) {
    lines.push(
      "",
      "### Value mismatches",
      "",
      "| Token | Category | Figma | Code |",
      "|---|---|---|---|",
    );
    for (const mismatch of valueMismatches) {
      lines.push(
        `| \`${escapeCell(mismatch.name)}\` | ${mismatch.category} | ` +
          `\`${escapeCell(mismatch.figmaValue)}\` | \`${escapeCell(mismatch.codeValue)}\` |`,
      );
    }
  }

  if (missingInCode.length > 0) {
    lines.push("", "### Missing in code", "", "| Token | Category | Value (Figma) |", "|---|---|---|");
    for (const token of missingInCode) {
      lines.push(`| \`${escapeCell(token.name)}\` | ${token.category} | \`${escapeCell(token.value)}\` |`);
    }
  }

  if (missingInFigma.length > 0) {
    lines.push("", "### Missing in Figma", "", "| Token | Category | Value (code) |", "|---|---|---|");
    for (const token of missingInFigma) {
      lines.push(`| \`${escapeCell(token.name)}\` | ${token.category} | \`${escapeCell(token.value)}\` |`);
    }
  }

  return lines.join("\n");
}
