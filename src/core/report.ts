import type { ComponentIssue, DriftItem, DriftResult } from "./diff.js";

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

/** Machine-readable counts for drift-status.json. Old keys never change. */
export function buildStatusPayload(result: DriftResult): Record<string, unknown> {
  return {
    driftFound: result.driftFound,
    valueMismatches: result.valueMismatches.length,
    missingInCode: result.missingInCode.length,
    missingInFigma: result.missingInFigma.length,
    componentsOutOfDate: result.componentsOutOfDate.length,
    componentsChangedInFigma: result.componentsChangedInFigma.length,
    componentsInCodeNotInFigma: result.componentsInCodeNotInFigma.length,
    componentsInFigmaNotInCode: result.componentsInFigmaNotInCode.length,
    deprecatedStillInCode: result.deprecatedStillInCode.length,
    deprecationOverdue: result.deprecationOverdue.length,
    safeToRemoveFromDeprecations: result.safeToRemoveFromDeprecations.length,
  };
}

/** Everything that counts as drift — informational sections do not. */
function totalDrift(result: DriftResult): number {
  return (
    result.valueMismatches.length +
    result.missingInCode.length +
    result.missingInFigma.length +
    result.componentsOutOfDate.length +
    result.componentsChangedInFigma.length +
    result.componentsInCodeNotInFigma.length +
    result.componentsInFigmaNotInCode.length +
    result.deprecationOverdue.length
  );
}

export function buildReport(result: DriftResult, meta: ReportMeta): string {
  const { valueMismatches, missingInCode, missingInFigma } = result;

  const lines: string[] = [
    "## Design token drift report",
    "",
    `Checked **${meta.figmaTokenCount}** Figma tokens (${meta.figmaSource}) against ` +
      `**${meta.codeTokenCount}** codebase tokens (${meta.codebaseSource}) ` +
      `at ${meta.checkedAt}.`,
  ];

  const hasInformational =
    result.deprecatedStillInCode.length > 0 || result.safeToRemoveFromDeprecations.length > 0 || Boolean(result.intentionalDifferences?.length);

  if (!result.driftFound) {
    lines.push("", "✅ **No drift detected.** Figma and codebase tokens are in agreement.");
    if (!hasInformational) return lines.join("\n");
  } else {
    lines.push(
      "",
      "### Summary",
      "",
      "| Check | Count |",
      "|---|---|",
      `| Value mismatches (same name, different value) | ${valueMismatches.length} |`,
      `| Missing in code (in Figma, not in the codebase) | ${missingInCode.length} |`,
      `| Missing in Figma (in the codebase, not in Figma) | ${missingInFigma.length} |`,
    );

    const extraRows: [string, number][] = [
      ["Components out of date (code changed since the last sync)", result.componentsOutOfDate.length],
      ["Components changed in Figma (node changed since the last sync)", result.componentsChangedInFigma.length],
      ["Components in code, not in Figma (never synced)", result.componentsInCodeNotInFigma.length],
      ["Components in Figma, not in code (stale elf nodes)", result.componentsInFigmaNotInCode.length],
      ["Deprecations overdue", result.deprecationOverdue.length],
    ];
    for (const [label, count] of extraRows) {
      if (count > 0) lines.push(`| ${label} | ${count} |`);
    }

    lines.push(`| **Total drift** | **${totalDrift(result)}** |`);
  }

  if (valueMismatches.length > 0) {
    lines.push(
      "",
      "### Value mismatches",
      "",
      "| Token | Category | Figma | Code |",
      "|---|---|---|---|",
    );
    for (const mismatch of valueMismatches) {
      const mode = mismatch.mode === undefined ? "" : ` (${escapeCell(mismatch.mode)})`;
      lines.push(
        `| \`${escapeCell(mismatch.name)}\`${mode} | ${mismatch.category} | ` +
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
    lines.push(
      "",
      "### Missing in Figma",
      "",
      "New in code: never in Figma, or removed from Figma without being marked deprecated.",
      "",
      "| Token | Category | Value (code) |",
      "|---|---|---|",
    );
    for (const token of missingInFigma) {
      lines.push(`| \`${escapeCell(token.name)}\` | ${token.category} | \`${escapeCell(token.value)}\` |`);
    }
  }

  renderComponents(lines, "Components out of date", "The code spec changed since the last sync — re-run elf-batch to push it.", result.componentsOutOfDate);
  renderComponents(lines, "Components changed in Figma", "The Figma node changed since the last sync — review it, then re-run elf-batch to adopt it.", result.componentsChangedInFigma);
  renderComponents(lines, "Components in code, not in Figma", "These components exist in code but have no Figma counterpart.", result.componentsInCodeNotInFigma);
  renderComponents(lines, "Components in Figma, not in code", "These nodes carry an elf codeKey but no matching component file.", result.componentsInFigmaNotInCode);

  renderDeprecations(lines, "Accepted intentional differences", result.intentionalDifferences ?? []);
  renderDeprecations(lines, "Deprecated (still in code)", result.deprecatedStillInCode);
  renderDeprecations(lines, "Deprecation overdue", result.deprecationOverdue);
  renderDeprecations(lines, "Safe to remove from the deprecations list", result.safeToRemoveFromDeprecations);

  return lines.join("\n");
}

function renderComponents(lines: string[], title: string, blurb: string, issues: ComponentIssue[]): void {
  if (issues.length === 0) return;
  lines.push("", `### ${title}`, "", blurb, "", "| Component | codeKey | Detail |", "|---|---|---|");
  for (const issue of issues) {
    lines.push(
      `| \`${escapeCell(issue.name)}\` | \`${escapeCell(issue.codeKey ?? "—")}\` | ${escapeCell(issue.detail ?? "")} |`,
    );
  }
}

function renderDeprecations(lines: string[], title: string, items: DriftItem[]): void {
  if (items.length === 0) return;
  lines.push("", `### ${title}`, "", "| Item | Type | Detail |", "|---|---|---|");
  for (const item of items) {
    lines.push(`| \`${escapeCell(item.name)}\` | ${item.kind} | ${escapeCell(item.detail ?? "")} |`);
  }
}
