import type { Token } from "./types.js";

export interface ValueMismatch {
  name: string;
  category: string;
  figmaValue: string;
  codeValue: string;
  /** Set in multi-mode comparisons — which Figma mode this value came from. */
  mode?: string;
}

/** One entry of the component-diff sections. */
export interface ComponentIssue {
  codeHash?: string;
  figmaHash?: string;
  name: string;
  codeKey?: string;
  file?: string;
  nodeId?: string;
  detail?: string;
}

/** One entry of the deprecation sections. */
export interface DriftItem {
  kind: "token" | "component";
  name: string;
  detail?: string;
}

export interface DriftResult {
  intentionalDifferences?: DriftItem[];
  valueMismatches: ValueMismatch[];
  missingInCode: Token[];
  missingInFigma: Token[];
  componentsOutOfDate: ComponentIssue[];
  componentsChangedInFigma: ComponentIssue[];
  componentsInCodeNotInFigma: ComponentIssue[];
  componentsInFigmaNotInCode: ComponentIssue[];
  /** Deprecated in the config, still in code, not in Figma — informational, not drift. */
  deprecatedStillInCode: DriftItem[];
  /** Deprecated with a removeBy date in the past — drift. */
  deprecationOverdue: DriftItem[];
  /** In the deprecations list but no longer in code — clean up the list. */
  safeToRemoveFromDeprecations: DriftItem[];
  driftFound: boolean;
}

/** Token-only diff. Component and deprecation sections start empty. */
export function diffTokens(
  figmaTokens: Token[],
  codeTokens: Token[],
  nameMapping: Record<string, string>,
): DriftResult {
  const mapName = (name: string): string => nameMapping[name] ?? name;

  // One name can carry several Figma tokens in multi-mode runs — one per mode.
  const figmaByName = new Map<string, Token[]>();
  for (const token of figmaTokens) {
    const name = mapName(token.name);
    const list = figmaByName.get(name) ?? [];
    list.push({ ...token, name });
    figmaByName.set(name, list);
  }

  const codeModes = new Map<string, Token>();
  const codeByName = new Map<string, Token>();
  for (const token of codeTokens) {
    if (token.mode !== undefined) codeModes.set(`${token.name}\0${token.mode}`,token);
    if (token.mode === undefined || !codeByName.has(token.name)) codeByName.set(token.name, token);
  }

  const valueMismatches: ValueMismatch[] = [];
  const missingInCode: Token[] = [];
  const missingInFigma: Token[] = [];

  for (const [name, figmaList] of figmaByName) {
    const codeToken = codeByName.get(name);
    if (!codeToken) {
      // Missing entirely: one entry per name, not one per mode.
      const first = figmaList[0];
      if (first) missingInCode.push(first);
      continue;
    }
    for (const figmaToken of figmaList) {
      const comparedCode = figmaToken.mode === undefined ? codeToken : codeModes.get(`${name}\0${figmaToken.mode}`) ?? codeToken;
      if (comparedCode.value === figmaToken.value) continue;
      valueMismatches.push({
        name,
        category: figmaToken.category,
        figmaValue: figmaToken.value,
        codeValue: comparedCode.value,
        ...(figmaToken.mode === undefined ? {} : { mode: figmaToken.mode }),
      });
    }
  }

  for (const [name, codeToken] of codeByName) {
    if (!figmaByName.has(name)) {
      missingInFigma.push(codeToken);
    }
  }

  const result: DriftResult = {
    valueMismatches,
    missingInCode,
    missingInFigma,
    componentsOutOfDate: [],
    componentsChangedInFigma: [],
    componentsInCodeNotInFigma: [],
    componentsInFigmaNotInCode: [],
    deprecatedStillInCode: [],
    deprecationOverdue: [],
    safeToRemoveFromDeprecations: [],
    driftFound: false,
  };
  result.driftFound = hasDrift(result);
  return result;
}

/**
 * Drift is any value mismatch, any one-sided token, any component issue, or
 * an overdue deprecation. Informational deprecation sections do not count.
 */
export function hasDrift(result: DriftResult): boolean {
  return (
    result.valueMismatches.length > 0 ||
    result.missingInCode.length > 0 ||
    result.missingInFigma.length > 0 ||
    result.componentsOutOfDate.length > 0 ||
    result.componentsChangedInFigma.length > 0 ||
    result.componentsInCodeNotInFigma.length > 0 ||
    result.componentsInFigmaNotInCode.length > 0 ||
    result.deprecationOverdue.length > 0
  );
}
