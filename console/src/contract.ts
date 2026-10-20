/**
 * The wire shapes of CONTRACT.md schema 1 plus the validators and helpers the
 * API uses to enforce them. Unknown fields are ignored (never rejected) so
 * newer clients can talk to older servers.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Context } from "hono";

export const CONTRACT_SCHEMA = 1;
export const CONTRACT_VERSION = "1.0.0";
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface PayloadToken {
  name: string;
  value: string;
  /** Code snapshots always carry it; plugin snapshots may send only `type`. */
  category?: string;
  mode?: string;
  collection?: string;
  type?: string;
}

export interface PayloadComponent {
  name: string;
  codeKey?: string;
  specHash?: string;
  nodeHash?: string;
  figmaNodeId?: string;
}

export interface CodeSnapshotPayload {
  source: "cli" | "watcher";
  checkedAt: string;
  git?: { branch: string; commit: string };
  config: {
    figmaFileKey: string;
    figmaSource?: string;
    codebaseSource?: string;
    modeStrategy?: string;
    modeName?: string | string[] | null;
  };
  figmaTokens: PayloadToken[];
  codeTokens: PayloadToken[];
  components?: PayloadComponent[];
  drift?: { found: boolean; counts: Record<string, unknown> };
  report?: string;
}

export interface FigmaSnapshotPayload {
  figma: { fileKey: string; fileName?: string };
  capturedAt: string;
  tokens: PayloadToken[];
  components?: PayloadComponent[];
  pluginVersion?: string;
}

export interface Issues {
  ok: false;
  issues: string[];
}

/** Deterministic JSON (sorted keys everywhere) — the dedupe content hash input. */
export function canonicalJson(value: unknown): string {
  const clean: unknown = JSON.parse(JSON.stringify(value));
  return stringifyStable(clean);
}

function stringifyStable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(stringifyStable).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringifyStable(record[key])}`).join(",")}}`;
}

export function errorJson(
  c: Context,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return c.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    status as ContentfulStatusCode,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? (record[key] as string) : undefined;
}

function readTokenList(
  value: unknown,
  field: string,
  requireCategory: boolean,
  issues: string[],
): PayloadToken[] {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (!isRecord(item)) {
      issues.push(`${field}[${index}] must be an object`);
      return [];
    }
    const token: PayloadToken = { name: "", value: "" };
    if (isNonEmptyString(item.name)) token.name = item.name;
    else issues.push(`${field}[${index}].name must be a non-empty string`);
    if (typeof item.value === "string") token.value = item.value;
    else issues.push(`${field}[${index}].value must be a string`);
    if (requireCategory && !isNonEmptyString(item.category)) {
      issues.push(`${field}[${index}].category must be a non-empty string`);
    } else {
      const category = readOptionalString(item, "category");
      if (category !== undefined) token.category = category;
    }
    const mode = readOptionalString(item, "mode");
    if (mode !== undefined) token.mode = mode;
    const collection = readOptionalString(item, "collection");
    if (collection !== undefined) token.collection = collection;
    const type = readOptionalString(item, "type");
    if (type !== undefined) token.type = type;
    return [token];
  });
}

function readComponentList(value: unknown, field: string, issues: string[]): PayloadComponent[] {
  if (!Array.isArray(value)) {
    issues.push(`${field} must be an array`);
    return [];
  }
  return value.flatMap((item, index) => {
    if (!isRecord(item) || !isNonEmptyString(item.name)) {
      issues.push(`${field}[${index}].name must be a non-empty string`);
      return [];
    }
    const component: PayloadComponent = { name: item.name };
    const codeKey = readOptionalString(item, "codeKey");
    if (codeKey !== undefined) component.codeKey = codeKey;
    const specHash = readOptionalString(item, "specHash");
    if (specHash !== undefined) component.specHash = specHash;
    const nodeHash = readOptionalString(item, "nodeHash");
    if (nodeHash !== undefined) component.nodeHash = nodeHash;
    const figmaNodeId = readOptionalString(item, "figmaNodeId");
    if (figmaNodeId !== undefined) component.figmaNodeId = figmaNodeId;
    return [component];
  });
}

export function validateCodePayload(
  value: unknown,
): { ok: true; value: CodeSnapshotPayload } | Issues {
  if (!isRecord(value)) return { ok: false, issues: ["body must be a JSON object"] };
  const issues: string[] = [];

  const source = value.source;
  if (source !== "cli" && source !== "watcher") issues.push('source must be "cli" or "watcher"');
  if (!isIsoTimestamp(value.checkedAt)) issues.push("checkedAt must be an ISO 8601 UTC timestamp");

  let figmaFileKey = "";
  if (!isRecord(value.config)) {
    issues.push("config must be an object");
  } else if (!isNonEmptyString(value.config.figmaFileKey)) {
    issues.push("config.figmaFileKey must be a non-empty string");
  } else {
    figmaFileKey = value.config.figmaFileKey;
  }

  const figmaTokens = readTokenList(value.figmaTokens, "figmaTokens", true, issues);
  const codeTokens = readTokenList(value.codeTokens, "codeTokens", true, issues);

  let git: CodeSnapshotPayload["git"];
  if (value.git !== undefined) {
    if (!isRecord(value.git) || !isNonEmptyString(value.git.branch) || !isNonEmptyString(value.git.commit)) {
      issues.push("git must be { branch, commit } non-empty strings");
    } else {
      git = { branch: value.git.branch, commit: value.git.commit };
    }
  }

  const components =
    value.components === undefined ? undefined : readComponentList(value.components, "components", issues);

  let drift: CodeSnapshotPayload["drift"];
  if (value.drift !== undefined) {
    if (!isRecord(value.drift) || typeof value.drift.found !== "boolean") {
      issues.push("drift must be { found: boolean, counts?: object }");
    } else if (value.drift.counts !== undefined && !isRecord(value.drift.counts)) {
      issues.push("drift.counts must be an object");
    } else {
      drift = { found: value.drift.found, counts: isRecord(value.drift.counts) ? value.drift.counts : {} };
    }
  }

  let report: string | undefined;
  if (value.report !== undefined) {
    if (typeof value.report !== "string") issues.push("report must be a string");
    else report = value.report;
  }

  if (issues.length > 0) return { ok: false, issues };

  const config = value.config as Record<string, unknown>;
  const figmaSource = readOptionalString(config, "figmaSource");
  const codebaseSource = readOptionalString(config, "codebaseSource");
  const modeStrategy = readOptionalString(config, "modeStrategy");
  const modeName = config.modeName;
  const modeNameValue =
    modeName === null || typeof modeName === "string"
      ? modeName
      : Array.isArray(modeName) && modeName.every((name) => typeof name === "string")
        ? (modeName as string[])
        : undefined;

  const payload: CodeSnapshotPayload = {
    source: source as CodeSnapshotPayload["source"],
    checkedAt: value.checkedAt as string,
    config: {
      figmaFileKey,
      ...(figmaSource === undefined ? {} : { figmaSource }),
      ...(codebaseSource === undefined ? {} : { codebaseSource }),
      ...(modeStrategy === undefined ? {} : { modeStrategy }),
      ...(modeNameValue === undefined ? {} : { modeName: modeNameValue }),
    },
    figmaTokens,
    codeTokens,
    ...(git === undefined ? {} : { git }),
    ...(components === undefined ? {} : { components }),
    ...(drift === undefined ? {} : { drift }),
    ...(report === undefined ? {} : { report }),
  };
  return { ok: true, value: payload };
}

export function validateFigmaPayload(
  value: unknown,
): { ok: true; value: FigmaSnapshotPayload } | Issues {
  if (!isRecord(value)) return { ok: false, issues: ["body must be a JSON object"] };
  const issues: string[] = [];

  let fileKey = "";
  if (!isRecord(value.figma)) {
    issues.push("figma must be an object");
  } else if (!isNonEmptyString(value.figma.fileKey)) {
    issues.push("figma.fileKey must be a non-empty string");
  } else {
    fileKey = value.figma.fileKey;
  }
  if (!isIsoTimestamp(value.capturedAt)) issues.push("capturedAt must be an ISO 8601 UTC timestamp");

  const tokens = readTokenList(value.tokens, "tokens", false, issues);
  const components =
    value.components === undefined ? undefined : readComponentList(value.components, "components", issues);
  const pluginVersion = value.pluginVersion;
  if (pluginVersion !== undefined && typeof pluginVersion !== "string") {
    issues.push("pluginVersion must be a string");
  }

  if (issues.length > 0) return { ok: false, issues };

  const fileName = isRecord(value.figma) ? readOptionalString(value.figma, "fileName") : undefined;
  const payload: FigmaSnapshotPayload = {
    figma: { fileKey, ...(fileName === undefined ? {} : { fileName }) },
    capturedAt: value.capturedAt as string,
    tokens,
    ...(components === undefined ? {} : { components }),
    ...(typeof pluginVersion === "string" ? { pluginVersion } : {}),
  };
  return { ok: true, value: payload };
}
