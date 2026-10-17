import type { DriftResult, DriftItem } from "./diff.js";
import { hasDrift } from "./diff.js";
import type { Deprecation, Token } from "./types.js";

export interface DeprecationInputs {
  /** Every token the codebase defines. */
  codeTokens: Token[];
  /** Every component the codebase defines (name + codeKey). */
  codeComponents: { name: string; codeKey: string }[];
}

/**
 * The intentional-divergence allowlist. A deprecated item that is gone from
 * Figma but still in code is expected — informational, not drift — until its
 * `removeBy` date passes, at which point it counts. An item that left the
 * code entirely means the deprecations list can drop it.
 */
export function applyDeprecations(
  result: DriftResult,
  deprecations: Deprecation[],
  inputs: DeprecationInputs,
  today: string,
): DriftResult {
  if (deprecations.length === 0) return result;

  const missingInFigma = [...result.missingInFigma];
  const componentsInCodeNotInFigma = [...result.componentsInCodeNotInFigma];
  const deprecatedStillInCode = [...result.deprecatedStillInCode];
  const deprecationOverdue = [...result.deprecationOverdue];
  const safeToRemoveFromDeprecations = [...result.safeToRemoveFromDeprecations];

  for (const deprecation of deprecations) {
    // "2026-12-01" < "2026-12-02" lexically — dates compare as written.
    const overdue = deprecation.removeBy !== undefined && deprecation.removeBy < today;

    if (deprecation.type === "token") {
      const index = missingInFigma.findIndex((token) => token.name === deprecation.name);
      if (index > -1) {
        const [token] = missingInFigma.splice(index, 1);
        push(overdue ? deprecationOverdue : deprecatedStillInCode, {
          kind: "token",
          name: token.name,
          detail: describe(deprecation, token),
        });
      } else if (!inputs.codeTokens.some((token) => token.name === deprecation.name)) {
        // Not in Figma and not in code: the removal is complete.
        safeToRemoveFromDeprecations.push({
          kind: "token",
          name: deprecation.name,
          detail: describe(deprecation),
        });
      }
      // Otherwise it is still on both sides: a live deprecation, nothing to say.
      continue;
    }

    const index = componentsInCodeNotInFigma.findIndex(
      (issue) => issue.name === deprecation.name || issue.codeKey === deprecation.name,
    );
    if (index > -1) {
      const [issue] = componentsInCodeNotInFigma.splice(index, 1);
      push(overdue ? deprecationOverdue : deprecatedStillInCode, {
        kind: "component",
        name: issue.name,
        detail: describe(deprecation, issue),
      });
    } else if (
      !inputs.codeComponents.some(
        (component) => component.name === deprecation.name || component.codeKey === deprecation.name,
      )
    ) {
      safeToRemoveFromDeprecations.push({
        kind: "component",
        name: deprecation.name,
        detail: describe(deprecation),
      });
    }
  }

  const updated: DriftResult = {
    ...result,
    missingInFigma,
    componentsInCodeNotInFigma,
    deprecatedStillInCode,
    deprecationOverdue,
    safeToRemoveFromDeprecations,
  };
  updated.driftFound = hasDrift(updated);
  return updated;
}

function push(list: DriftItem[], item: DriftItem): void {
  list.push(item);
}

function describe(
  deprecation: Deprecation,
  item?: { value?: string; file?: string },
): string | undefined {
  const parts: string[] = [];
  if (deprecation.reason) parts.push(deprecation.reason);
  if (deprecation.since) parts.push(`deprecated since ${deprecation.since}`);
  if (deprecation.removeBy) parts.push(`remove by ${deprecation.removeBy}`);
  if (item?.value !== undefined) parts.push(`still in code as \`${item.value}\``);
  if (item?.file !== undefined) parts.push(`still in ${item.file}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}
