import type { Token } from "./types.js";

export interface ValueMismatch {
  name: string;
  category: string;
  figmaValue: string;
  codeValue: string;
}

export interface DriftResult {
  valueMismatches: ValueMismatch[];
  missingInCode: Token[];
  missingInFigma: Token[];
  driftFound: boolean;
}

export function diffTokens(
  figmaTokens: Token[],
  codeTokens: Token[],
  nameMapping: Record<string, string>,
): DriftResult {
  const mapName = (name: string): string => nameMapping[name] ?? name;

  const figmaByName = new Map<string, Token>();
  for (const token of figmaTokens) {
    figmaByName.set(mapName(token.name), { ...token, name: mapName(token.name) });
  }

  const codeByName = new Map<string, Token>();
  for (const token of codeTokens) {
    codeByName.set(token.name, token);
  }

  const valueMismatches: ValueMismatch[] = [];
  const missingInCode: Token[] = [];
  const missingInFigma: Token[] = [];

  for (const [name, figmaToken] of figmaByName) {
    const codeToken = codeByName.get(name);
    if (!codeToken) {
      missingInCode.push(figmaToken);
      continue;
    }
    if (codeToken.value !== figmaToken.value) {
      valueMismatches.push({
        name,
        category: figmaToken.category,
        figmaValue: figmaToken.value,
        codeValue: codeToken.value,
      });
    }
  }

  for (const [name, codeToken] of codeByName) {
    if (!figmaByName.has(name)) {
      missingInFigma.push(codeToken);
    }
  }

  const driftFound =
    valueMismatches.length > 0 || missingInCode.length > 0 || missingInFigma.length > 0;

  return { valueMismatches, missingInCode, missingInFigma, driftFound };
}
