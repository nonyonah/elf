import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { cssColorToHex, toPx } from "../../src/core/normalize.js";
import { parseComponents } from "../../batch/src/parser.js";
import { planTokens, type TokenIndex, type TokenIndexEntry } from "../../batch/src/tokens.js";
import type { BatchConfig } from "../../batch/src/types.js";

export interface LintFinding {
  file: string;
  line: number;
  column: number;
  value: string;
  kind: "color" | "dimension";
  normalized: string;
  suggestion: string | null;
}

export interface LintResult {
  findings: LintFinding[];
  files: number;
  errors: string[];
}

interface ValueMatch {
  index: number;
  value: string;
  kind: "color" | "dimension";
  normalized: string;
}

const PATTERNS: { kind: "color" | "dimension"; pattern: RegExp }[] = [
  { kind: "color", pattern: /#[0-9a-fA-F]{3,8}\b/g },
  { kind: "color", pattern: /\b(?:rgba?|hsla?)\([^)]*\)/g },
  { kind: "dimension", pattern: /-?(?:\d*\.)?\d+(?:px|rem)\b/g },
];

/**
 * Finds raw colors and pixel/rem values in component source. Values are
 * normalized with elf's own color/size helpers so a suggestion always matches
 * how the drift checker compares tokens.
 */
export function lintFiles(files: string[], config: BatchConfig): LintResult {
  const { index } = planTokens(config.tokensFile, config);
  const findings: LintFinding[] = [];
  const errors: string[] = [];
  let checked = 0;

  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch (error) {
      errors.push(`${file}: ${(error as Error).message}`);
      continue;
    }
    checked += 1;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = stripComments(lines[i]);
      for (const match of matchesOnLine(line)) {
        findings.push({
          file,
          line: i + 1,
          column: match.index + 1,
          value: match.value,
          kind: match.kind,
          normalized: match.normalized,
          suggestion: nearestToken(index, match.kind, match.normalized),
        });
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
  return { findings, files: checked, errors };
}

/** Default lint target: every parsed component file. */
export function componentFiles(config: BatchConfig): string[] {
  try {
    return parseComponents(config.componentsDir, config.componentFiles).map((component) =>
      resolve(config.componentsDir, component.file),
    );
  } catch {
    return [];
  }
}

export function formatFinding(finding: LintFinding): string {
  const file = relative(process.cwd(), finding.file) || finding.file;
  const suggestion = finding.suggestion
    ? `${finding.suggestion} (${finding.normalized})`
    : "no matching token";
  return `${file}:${finding.line}:${finding.column} ${finding.value} → ${suggestion}`;
}

function matchesOnLine(line: string): ValueMatch[] {
  const matches: ValueMatch[] = [];
  for (const { kind, pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      const value = match[0];
      const normalized = kind === "color" ? cssColorToHex(value) : toPx(value);
      if (normalized === null) continue;
      if (kind === "dimension" && normalized === "0px") continue;
      matches.push({ index: match.index ?? 0, value, kind, normalized });
    }
  }
  matches.sort((a, b) => a.index - b.index || b.value.length - a.value.length);
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.index}:${match.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripComments(line: string): string {
  return line.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/, "");
}

function nearestToken(
  index: TokenIndex,
  kind: "color" | "dimension",
  normalized: string,
): string | null {
  let best: { codeKey: string; distance: number } | null = null;
  for (const [codeKey, entry] of index) {
    if (kind === "color" && entry.type !== "COLOR") continue;
    if (kind === "dimension" && entry.type !== "FLOAT") continue;
    const candidate = normalizedToken(entry);
    if (candidate === null) continue;
    const distance =
      kind === "color"
        ? colorDistance(normalized, candidate)
        : Math.abs(parseFloat(normalized) - parseFloat(candidate));
    if (!Number.isFinite(distance)) continue;
    if (distance === 0) return codeKey;
    if (!best || distance < best.distance) best = { codeKey, distance };
  }
  return best?.codeKey ?? null;
}

function normalizedToken(entry: TokenIndexEntry): string | null {
  if (entry.literal === null) return null;
  if (entry.type === "COLOR" && typeof entry.literal === "string") {
    return cssColorToHex(entry.literal);
  }
  if (entry.type === "FLOAT" && typeof entry.literal === "number") {
    return toPx(entry.literal);
  }
  return null;
}

function colorDistance(a: string, b: string): number {
  const left = hexChannels(a);
  const right = hexChannels(b);
  if (!left || !right) return Number.NaN;
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2], left[3] - right[3]);
}

function hexChannels(hex: string): [number, number, number, number] | null {
  const value = hex.replace("#", "");
  if (value.length !== 6 && value.length !== 8) return null;
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return [channel(0), channel(2), channel(4), value.length === 8 ? channel(6) : 255];
}
