/**
 * Server-side drift recompute. Per CONTRACT.md the client's own verdict is
 * "for reference — the server recomputes from stored snapshots" and this is
 * that recompute, using elf core (elf-tokens/core):
 *
 * - tokens: exact — both sides ride the latest code snapshot (the CLI fetched
 *   Figma itself; a Figma snapshot alone cannot be diffed without code).
 * - components: from the latest code + Figma snapshots:
 *     in code / not in Figma (and back) by codeKey (fallback: name),
 *     changedInFigma by nodeHash drift,
 *     outOfDate by specHash drift since the previous code snapshot while the
 *     Figma node stayed put — an approximation of "changed since the last
 *     sync"; the CLI's manifest remains authoritative.
 * - deprecations: from the dashboard's own table (the remote-config source).
 *
 * Schema-1 assumptions (flagged for review, see DASHBOARD-SCOPE.md):
 * nameMapping is `{}` server-side (not pushed, not stored) and a project with
 * no code snapshot yet is `unknown`.
 */
import {
  applyDeprecations,
  buildStatusPayload,
  diffTokens,
  hasDrift,
  type Deprecation,
  type DriftResult,
  type Token,
} from "elf-tokens/core";
import type { CodeSnapshotPayload, FigmaSnapshotPayload, PayloadComponent, PayloadToken } from "./contract.js";

/** Data older than this anywhere in the project reads as `stale`. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface DriftCounts {
  [key: string]: number;
}

export interface ProjectStatus {
  state: "ok" | "drift" | "stale" | "unknown";
  checkedAt: string;
  counts: DriftCounts;
}

export interface SnapshotRow {
  id: string;
  payload: string;
  receivedAt: string;
  gitBranch: string | null;
  gitCommit: string | null;
}

async function latestSnapshot(
  db: D1Database,
  projectId: string,
  kind: "code" | "figma",
  offset = 0,
): Promise<SnapshotRow | null> {
  return db
    .prepare(
      `SELECT id, payload, receivedAt, gitBranch, gitCommit FROM snapshots
       WHERE projectId = ? AND kind = ?
       ORDER BY receivedAt DESC, rowid DESC LIMIT 1 OFFSET ?`,
    )
    .bind(projectId, kind, offset)
    .first<SnapshotRow>();
}

function toCoreToken(token: PayloadToken, source: "figma" | "code"): Token {
  return {
    name: token.name,
    category: (token.category ?? "color") as Token["category"],
    value: token.value,
    source,
    ...(token.mode === undefined ? {} : { mode: token.mode }),
  };
}

function componentKey(component: PayloadComponent): string {
  return component.codeKey ?? component.name;
}

export function zeroCounts(): DriftCounts {
  return {
    valueMismatches: 0,
    missingInCode: 0,
    missingInFigma: 0,
    componentsOutOfDate: 0,
    componentsChangedInFigma: 0,
    componentsInCodeNotInFigma: 0,
    componentsInFigmaNotInCode: 0,
    deprecationOverdue: 0,
    deprecatedStillInCode: 0,
    safeToRemoveFromDeprecations: 0,
  };
}

async function readDeprecations(db: D1Database, projectId: string): Promise<Deprecation[]> {
  const rows = await db
    .prepare(
      "SELECT name, type, reason, since, removeBy FROM deprecations WHERE projectId = ? ORDER BY name",
    )
    .bind(projectId)
    .all<{ name: string; type: "token" | "component"; reason: string | null; since: string | null; removeBy: string | null }>();
  return rows.results.map((row) => ({
    name: row.name,
    type: row.type,
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.since === null ? {} : { since: row.since }),
    ...(row.removeBy === null ? {} : { removeBy: row.removeBy }),
  }));
}

export interface DriftDetails {
  /** Null when the project has no code snapshot yet — nothing to compare. */
  result: DriftResult | null;
  code: CodeSnapshotPayload | null;
  figma: FigmaSnapshotPayload | null;
  codeSnapshot: SnapshotRow | null;
  figmaSnapshot: SnapshotRow | null;
}

/**
 * The pure recompute — shared by the drift job and the dashboard detail view,
 * so the UI and the stored run can never disagree about how drift is defined.
 */
export async function computeDriftDetails(db: D1Database, projectId: string): Promise<DriftDetails> {
  const codeSnapshot = await latestSnapshot(db, projectId, "code");
  if (!codeSnapshot) {
    return { result: null, code: null, figma: null, codeSnapshot: null, figmaSnapshot: null };
  }
  const code = JSON.parse(codeSnapshot.payload) as CodeSnapshotPayload;
  const figmaSnapshot = await latestSnapshot(db, projectId, "figma");
  const figma = figmaSnapshot ? (JSON.parse(figmaSnapshot.payload) as FigmaSnapshotPayload) : null;
  const previousCodeSnapshot = await latestSnapshot(db, projectId, "code", 1);
  const previousCode = previousCodeSnapshot
    ? (JSON.parse(previousCodeSnapshot.payload) as CodeSnapshotPayload)
    : null;

  const figmaTokens = code.figmaTokens.map((token) => toCoreToken(token, "figma"));
  const codeTokens = code.codeTokens.map((token) => toCoreToken(token, "code"));

  let result: DriftResult = diffTokens(figmaTokens, codeTokens, {});

  const codeComponents = code.components ?? [];
  if (figma) {
    result = {
      ...result,
      ...componentDrift(codeComponents, figma.components ?? [], previousCode?.components ?? []),
    };
  }

  result = applyDeprecations(
    result,
    await readDeprecations(db, projectId),
    { codeTokens, codeComponents: codeComponents.map((c) => ({ name: c.name, codeKey: componentKey(c) })) },
    new Date().toISOString().slice(0, 10),
  );
  result.driftFound = hasDrift(result);

  return { result, code, figma, codeSnapshot, figmaSnapshot };
}

/**
 * Recompute one project's drift and record the run. Never throws for
 * data-level problems — a failed run is recorded as `unknown` so the status
 * endpoint can say so honestly.
 */
export async function runDrift(
  db: D1Database,
  projectId: string,
  triggeredBy: string,
  now: Date = new Date(),
): Promise<{ state: ProjectStatus["state"]; counts: DriftCounts }> {
  const createdAt = now.toISOString();
  try {
    const details = await computeDriftDetails(db, projectId);
    if (!details.result) {
      const counts = zeroCounts();
      await recordRun(db, projectId, "unknown", counts, triggeredBy, "Waiting for the first code snapshot.", createdAt);
      return { state: "unknown", counts };
    }

    const counts = countsFrom(details.result);
    const state: ProjectStatus["state"] = details.result.driftFound ? "drift" : "ok";
    await recordRun(db, projectId, state, counts, triggeredBy, null, createdAt);
    return { state, counts };
  } catch (error) {
    const counts = zeroCounts();
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(db, projectId, "unknown", counts, triggeredBy, message.slice(0, 500), createdAt);
    return { state: "unknown", counts };
  }
}

/**
 * Component sections from the two snapshots. Only runs when a Figma snapshot
 * exists — without one the server has no second opinion to compare against.
 */
function componentDrift(
  codeComponents: PayloadComponent[],
  figmaComponents: PayloadComponent[],
  previousCodeComponents: PayloadComponent[],
): Pick<
  DriftResult,
  "componentsOutOfDate" | "componentsChangedInFigma" | "componentsInCodeNotInFigma" | "componentsInFigmaNotInCode"
> {
  const figmaByKey = new Map(figmaComponents.map((component) => [componentKey(component), component]));
  const codeByKey = new Map(codeComponents.map((component) => [componentKey(component), component]));
  const previousSpecByKey = new Map(
    previousCodeComponents.map((component) => [componentKey(component), component.specHash]),
  );

  const outOfDate: DriftResult["componentsOutOfDate"] = [];
  const changedInFigma: DriftResult["componentsChangedInFigma"] = [];
  const inCodeNotInFigma: DriftResult["componentsInCodeNotInFigma"] = [];
  const inFigmaNotInCode: DriftResult["componentsInFigmaNotInCode"] = [];

  for (const component of codeComponents) {
    const key = componentKey(component);
    const base = { name: component.name, codeKey: component.codeKey ?? component.name };
    const figmaComponent = figmaByKey.get(key);

    if (!figmaComponent) {
      if (!component.nodeHash) {
        inCodeNotInFigma.push({ ...base, detail: "never synced to Figma" });
      } else {
        inCodeNotInFigma.push({ ...base, detail: "the Figma node is gone or renamed" });
      }
      continue;
    }

    if (component.nodeHash && figmaComponent.nodeHash && component.nodeHash !== figmaComponent.nodeHash) {
      const previousSpec = previousSpecByKey.get(key);
      const specChanged = previousSpec !== undefined && component.specHash !== previousSpec;
      changedInFigma.push({
        ...base,
        detail: specChanged
          ? "the Figma node changed since the last sync — and the code spec also changed"
          : "the Figma node changed since the last sync",
      });
      continue;
    }

    const previousSpec = previousSpecByKey.get(key);
    if (previousSpec !== undefined && component.specHash !== undefined && component.specHash !== previousSpec) {
      outOfDate.push({ ...base, detail: "the code spec changed since the last snapshot" });
    }
  }

  for (const component of figmaComponents) {
    const key = componentKey(component);
    if (!codeByKey.has(key)) {
      inFigmaNotInCode.push({ name: component.name, codeKey: component.codeKey ?? component.name });
    }
  }

  return {
    componentsOutOfDate: outOfDate,
    componentsChangedInFigma: changedInFigma,
    componentsInCodeNotInFigma: inCodeNotInFigma,
    componentsInFigmaNotInCode: inFigmaNotInCode,
  };
}

export function countsFrom(result: DriftResult): DriftCounts {
  const payload = buildStatusPayload(result);
  delete payload.driftFound;
  return payload as DriftCounts;
}

async function recordRun(
  db: D1Database,
  projectId: string,
  state: ProjectStatus["state"],
  counts: DriftCounts,
  triggeredBy: string,
  error: string | null,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO drift_runs (id, projectId, state, counts, triggeredBy, error, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), projectId, state, JSON.stringify(counts), triggeredBy, error, createdAt)
    .run();
}

/** What `GET /projects/me/status` reports: the latest run, aged for staleness. */
export async function readStatus(
  db: D1Database,
  projectId: string,
  nowMs: number = Date.now(),
): Promise<ProjectStatus> {
  const run = await db
    .prepare(
      "SELECT state, counts, createdAt FROM drift_runs WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1",
    )
    .bind(projectId)
    .first<{ state: ProjectStatus["state"]; counts: string | null; createdAt: string }>();
  if (!run) return { state: "unknown", checkedAt: new Date(nowMs).toISOString(), counts: zeroCounts() };

  let state = run.state;
  if (state !== "unknown") {
    const newest = await db
      .prepare("SELECT receivedAt FROM snapshots WHERE projectId = ? ORDER BY receivedAt DESC LIMIT 1")
      .bind(projectId)
      .first<{ receivedAt: string }>();
    if (newest && nowMs - Date.parse(newest.receivedAt) > STALE_AFTER_MS) state = "stale";
  }

  let counts = zeroCounts();
  if (run.counts) {
    try {
      counts = { ...counts, ...(JSON.parse(run.counts) as DriftCounts) };
    } catch {
      // A corrupted counts blob reads as zeros rather than failing the status call.
    }
  }
  return { state, checkedAt: run.createdAt, counts };
}
