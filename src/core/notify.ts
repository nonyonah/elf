/**
 * The pure half of the notify flow: message building and dedupe decisions.
 * Posting and the state file live in src/notify.ts — the CLI and the elf
 * console share this module so both post identical messages.
 */
import type { DriftResult } from "./diff.js";
import { sha256Hex } from "./hash.js";

export interface NotifyMeta {
  fileKey: string;
  figmaSource: string;
  codebaseSource: string;
  checkedAt: string;
  /** Optional link back to a report or console — appended to the context line. */
  url?: string;
}

/** What dedupe compares between runs: the full item set plus the drift verdict. */
export interface NotifyState {
  fingerprint: string;
  driftFound: boolean;
}

export interface NotifyMessage {
  /** Plain-text fallback — required by Slack, and the whole body for the "text" format. */
  text: string;
  /** Block Kit blocks; only set for the "slack" format. */
  blocks?: Record<string, unknown>[];
}

export type NotifyDecisionReason = "first-report" | "state-changed" | "unchanged";

export interface NotifyDecision {
  send: boolean;
  reason: NotifyDecisionReason;
  fingerprint: string;
}

const MAX_ITEMS = 10;

const plural = (count: number): string => (count === 1 ? "" : "s");

/** Informational deprecation sections — worth a note, but not drift. */
export function hasNotes(result: DriftResult): boolean {
  return result.deprecatedStillInCode.length > 0 || result.safeToRemoveFromDeprecations.length > 0;
}

/** Stable hash of every reported item — order-insensitive, value-sensitive. */
export function driftFingerprint(result: DriftResult): string {
  const groups = [
    result.valueMismatches.map((m) => `${m.name}\u0000${m.mode ?? ""}\u0000${m.figmaValue}\u0000${m.codeValue}`),
    result.missingInCode.map((t) => `${t.name}\u0000${t.value}`),
    result.missingInFigma.map((t) => `${t.name}\u0000${t.value}`),
    result.componentsOutOfDate.map((c) => `${c.name}\u0000${c.codeKey ?? ""}\u0000${c.detail ?? ""}`),
    result.componentsChangedInFigma.map((c) => `${c.name}\u0000${c.codeKey ?? ""}\u0000${c.detail ?? ""}`),
    result.componentsInCodeNotInFigma.map((c) => `${c.name}\u0000${c.codeKey ?? ""}\u0000${c.detail ?? ""}`),
    result.componentsInFigmaNotInCode.map((c) => `${c.name}\u0000${c.codeKey ?? ""}\u0000${c.detail ?? ""}`),
    result.deprecatedStillInCode.map((d) => `${d.kind}\u0000${d.name}`),
    result.deprecationOverdue.map((d) => `${d.kind}\u0000${d.name}`),
    result.safeToRemoveFromDeprecations.map((d) => `${d.kind}\u0000${d.name}`),
  ];
  const canonical = groups.map((group) => [...group].sort().join("\n")).join("\n--\n");
  return sha256Hex(canonical).slice(0, 16);
}

/**
 * Alerts only when something changed: a first report with anything to say,
 * or any difference from the previous state (including a recovery to clean).
 * Pass `onlyOnChange = false` to notify on every run instead.
 */
export function decideNotification(
  previous: NotifyState | null,
  result: DriftResult,
  onlyOnChange = true,
): NotifyDecision {
  const fingerprint = driftFingerprint(result);
  if (!onlyOnChange) {
    return { send: true, reason: previous === null ? "first-report" : "state-changed", fingerprint };
  }
  if (previous === null) {
    const noteworthy = result.driftFound || hasNotes(result);
    return { send: noteworthy, reason: noteworthy ? "first-report" : "unchanged", fingerprint };
  }
  if (previous.fingerprint === fingerprint) {
    return { send: false, reason: "unchanged", fingerprint };
  }
  return { send: true, reason: "state-changed", fingerprint };
}

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

function countLines(result: DriftResult): string[] {
  const rows: [string, number][] = [
    ["Value mismatches", result.valueMismatches.length],
    ["Missing in code", result.missingInCode.length],
    ["Missing in Figma", result.missingInFigma.length],
    ["Components out of date", result.componentsOutOfDate.length],
    ["Components changed in Figma", result.componentsChangedInFigma.length],
    ["Components in code, not in Figma", result.componentsInCodeNotInFigma.length],
    ["Components in Figma, not in code", result.componentsInFigmaNotInCode.length],
    ["Deprecations overdue", result.deprecationOverdue.length],
    ["Deprecated (still in code)", result.deprecatedStillInCode.length],
    ["Safe to remove from deprecations", result.safeToRemoveFromDeprecations.length],
  ];
  const always = new Set(["Value mismatches", "Missing in code", "Missing in Figma"]);
  return rows.filter(([label, count]) => count > 0 || always.has(label)).map(([label, count]) => `${label}: ${count}`);
}

const codeKey = (key: string | undefined): string => (key ? ` (${key})` : "");

function itemLines(result: DriftResult): string[] {
  const lines: string[] = [];
  for (const m of result.valueMismatches) {
    const mode = m.mode === undefined ? "" : ` (${m.mode})`;
    lines.push(`• \`${m.name}\`${mode}: \`${m.figmaValue}\` (Figma) → \`${m.codeValue}\` (code)`);
  }
  for (const t of result.missingInCode) lines.push(`• missing in code: \`${t.name}\` (\`${t.value}\`)`);
  for (const t of result.missingInFigma) lines.push(`• missing in Figma: \`${t.name}\` (\`${t.value}\`)`);
  for (const c of result.componentsOutOfDate) lines.push(`• out of date: \`${c.name}\`${codeKey(c.codeKey)}`);
  for (const c of result.componentsChangedInFigma) lines.push(`• changed in Figma: \`${c.name}\`${codeKey(c.codeKey)}`);
  for (const c of result.componentsInCodeNotInFigma) lines.push(`• in code, not in Figma: \`${c.name}\``);
  for (const c of result.componentsInFigmaNotInCode) lines.push(`• in Figma, not in code: \`${c.name}\``);
  for (const d of result.deprecationOverdue) {
    lines.push(`• deprecation overdue: \`${d.name}\`${d.detail ? ` (${d.detail})` : ""}`);
  }
  for (const d of result.deprecatedStillInCode) lines.push(`• deprecated, still in code: \`${d.name}\``);
  for (const d of result.safeToRemoveFromDeprecations) lines.push(`• safe to remove from deprecations: \`${d.name}\``);
  return lines;
}

export function buildNotifyMessage(
  result: DriftResult,
  meta: NotifyMeta,
  format: "slack" | "text",
  previous: NotifyState | null,
): NotifyMessage {
  const resolved = !result.driftFound && previous?.driftFound === true;
  const notes = result.deprecatedStillInCode.length + result.safeToRemoveFromDeprecations.length;

  const body: string[] = [];
  let headline: string;
  let fallback: string;

  if (result.driftFound) {
    const total = totalDrift(result);
    headline = "Design token drift detected";
    fallback = `Design token drift: ${total} item${plural(total)} (file ${meta.fileKey})`;
    body.push(...countLines(result));
  } else if (notes > 0) {
    headline = resolved ? "Drift resolved — deprecation notes remain" : "Deprecation notes";
    fallback = resolved
      ? `Design token drift resolved; ${notes} deprecation note${plural(notes)} remain (file ${meta.fileKey})`
      : `No drift; ${notes} deprecation note${plural(notes)} (file ${meta.fileKey})`;
  } else {
    headline = "Drift resolved";
    fallback = `Design token drift resolved: Figma and code tokens agree (file ${meta.fileKey})`;
  }

  const items = itemLines(result);
  if (items.length > 0) {
    if (body.length > 0) body.push("");
    body.push(...items.slice(0, MAX_ITEMS));
    if (items.length > MAX_ITEMS) body.push(`… and ${items.length - MAX_ITEMS} more — see the full report.`);
  }

  const contextBase = `${meta.figmaSource} vs ${meta.codebaseSource} · file \`${meta.fileKey}\` · checked ${meta.checkedAt}`;
  const context = meta.url ? `${contextBase} · <${meta.url}|Open the report>` : contextBase;

  if (format === "text") {
    const textContext = meta.url ? `${contextBase} · ${meta.url}` : contextBase;
    return { text: [fallback, "", ...body, "", textContext].join("\n") };
  }

  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: headline } },
  ];
  if (body.length > 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: body.join("\n") } });
  }
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: context }] });
  return { text: fallback, blocks };
}
