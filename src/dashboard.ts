/**
 * The dashboard API — everything under /api/* behind the Clerk gate (see
 * index.ts). Every route is workspace-scoped: the project id in the URL is
 * looked up inside the caller's workspace, so cross-tenant ids read as 404,
 * never as someone else's data.
 *
 * Shape notes (mirrors DASHBOARD-SCOPE.md):
 * - Project detail recomputes drift live via `computeDriftDetails` — one code
 *   path shared with the drift job, so the tables can never disagree with it.
 * - Connections are write-only: ciphertext in, masked tail out.
 * - All mutations land in audit_log.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getSession, workspaceNameFor, type AppEnv } from "./auth.js";
import { logAudit } from "./audit.js";
import { importSecretsKey, openSecret, sealSecret } from "./db/crypto.js";
import { createToken, type TokenKind } from "./db/tokens.js";
import { ensureWorkspace, findWorkspaceForUser, type Workspace } from "./db/workspaces.js";
import {
  buildSlackTestMessage,
  postSlackMessage,
  readNotificationRules,
  writeNotificationRules,
  type NotificationMode,
} from "./notify.js";
import {
  computeDriftDetails,
  countsFrom,
  readStatus,
  zeroCounts,
  type DriftCounts,
  type DriftDetails,
} from "./drift.js";
import type { CodeSnapshotPayload } from "./contract.js";

const MAX_BODY_BYTES = 64 * 1024;
const TREND_DAYS = 30;
const TREND_RUNS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

interface DeprecationRow {
  id: string;
  name: string;
  type: "token" | "component";
  reason: string | null;
  since: string | null;
  removeBy: string | null;
  createdAt: string;
}

type ConnectionType = "figma" | "slack";

interface ConnectionSecretRow {
  type: ConnectionType;
  encryptedSecret: string | null;
  iv: string | null;
  meta: string | null;
  status: string;
  statusMessage: string | null;
  updatedAt: string;
}

interface ConnectionView {
  type: ConnectionType;
  status: "unconfigured" | "bound" | "configured" | "error";
  statusMessage: string | null;
  secretTail: string | null;
  fileKey: string | null;
  fileName: string | null;
  updatedAt: string | null;
}

function fail(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return c.json({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

async function workspaceFor(c: Context<AppEnv>): Promise<Workspace> {
  const { userId } = getSession(c);
  const existing = await findWorkspaceForUser(c.env.DB, userId);
  if (existing) return existing;
  return ensureWorkspace(c.env.DB, userId, await workspaceNameFor(c.env, userId));
}

async function findProject(db: D1Database, workspaceId: string, projectId: string): Promise<ProjectRow | null> {
  return db
    .prepare("SELECT id, name, slug, createdAt FROM projects WHERE id = ? AND workspaceId = ?")
    .bind(projectId, workspaceId)
    .first<ProjectRow>();
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "project";
}

async function createProject(db: D1Database, workspaceId: string, name: string): Promise<ProjectRow> {
  const id = `prj_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const base = slugify(name);
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const taken = await db
      .prepare("SELECT id FROM projects WHERE workspaceId = ? AND slug = ?")
      .bind(workspaceId, slug)
      .first<{ id: string }>();
    if (taken) continue;
    try {
      await db
        .prepare("INSERT INTO projects (id, workspaceId, name, slug, createdAt) VALUES (?, ?, ?, ?, ?)")
        .bind(id, workspaceId, name, slug, createdAt)
        .run();
      return { id, name, slug, createdAt };
    } catch {
      // Slug raced with a concurrent create; try the next suffix.
    }
  }
  throw new Error("could not allocate a project slug");
}

async function readBody(
  c: Context<AppEnv>,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: fail(c, 413, "too_large", "The body is larger than 64 KB.") };
  }
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, response: fail(c, 400, "invalid_payload", "The body must be a JSON object.") };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, response: fail(c, 400, "invalid_payload", "The body must be valid JSON.") };
  }
}

/** Trimmed non-empty string within `max` chars, else null. */
function readString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/** null clears the field, a valid value replaces it, false means invalid. */
function readOptionalText(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? false : trimmed;
}

function readOptionalDate(value: unknown): string | null | false {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : false;
}

function parseCounts(raw: string | null): DriftCounts {
  const counts = zeroCounts();
  if (!raw) return counts;
  try {
    return { ...counts, ...(JSON.parse(raw) as DriftCounts) };
  } catch {
    return counts;
  }
}

function parseMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function totalDrift(counts: DriftCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
}

/** Last 30 UTC days, zeros included, oldest first — the Overview chart's spine. */
function emptyTrend(days: number = TREND_DAYS): { date: string; total: number }[] {
  const trend: { date: string; total: number }[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    trend.push({ date: new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10), total: 0 });
  }
  return trend;
}

async function workspaceTrend(db: D1Database, workspaceId: string): Promise<{ date: string; total: number }[]> {
  const trend = emptyTrend();
  const byDate = new Map(trend.map((day) => [day.date, day]));
  const since = new Date(Date.now() - TREND_DAYS * DAY_MS).toISOString();
  const runs = await db
    .prepare(
      `SELECT r.projectId AS projectId, r.createdAt AS createdAt, r.counts AS counts
       FROM drift_runs r JOIN projects p ON p.id = r.projectId
       WHERE p.workspaceId = ? AND r.createdAt >= ?
       ORDER BY r.createdAt ASC, r.rowid ASC`,
    )
    .bind(workspaceId, since)
    .all<{ projectId: string; createdAt: string; counts: string | null }>();

  // One point per project per day: the day's last run — so a chatty project
  // cannot inflate the chart by pushing often.
  const lastPerProjectDay = new Map<string, DriftCounts>();
  for (const run of runs.results) {
    lastPerProjectDay.set(`${run.createdAt.slice(0, 10)}|${run.projectId}`, parseCounts(run.counts));
  }
  for (const [key, counts] of lastPerProjectDay) {
    const day = byDate.get(key.slice(0, 10));
    if (day) day.total += totalDrift(counts);
  }
  return trend;
}

async function readConnection(
  db: D1Database,
  projectId: string,
  type: ConnectionType,
): Promise<ConnectionSecretRow | null> {
  return db
    .prepare(
      "SELECT type, encryptedSecret, iv, meta, status, statusMessage, updatedAt FROM connections WHERE projectId = ? AND type = ?",
    )
    .bind(projectId, type)
    .first<ConnectionSecretRow>();
}

async function upsertConnection(
  db: D1Database,
  projectId: string,
  type: ConnectionType,
  encryptedSecret: string | null,
  iv: string | null,
  meta: Record<string, unknown>,
  status: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO connections (id, projectId, type, encryptedSecret, iv, meta, status, statusMessage, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(projectId, type) DO UPDATE SET
         encryptedSecret = excluded.encryptedSecret,
         iv = excluded.iv,
         meta = excluded.meta,
         status = excluded.status,
         statusMessage = NULL,
         updatedAt = excluded.updatedAt`,
    )
    .bind(
      crypto.randomUUID(),
      projectId,
      type,
      encryptedSecret,
      iv,
      Object.keys(meta).length ? JSON.stringify(meta) : null,
      status,
      now,
      now,
    )
    .run();
}

async function connectionViews(db: D1Database, projectId: string): Promise<ConnectionView[]> {
  const figma = await readConnection(db, projectId, "figma");
  const slack = await readConnection(db, projectId, "slack");
  const source = await db
    .prepare("SELECT fileKey, fileName FROM figma_sources WHERE projectId = ?")
    .bind(projectId)
    .first<{ fileKey: string; fileName: string | null }>();

  const figmaMeta = parseMeta(figma?.meta ?? null);
  const slackMeta = parseMeta(slack?.meta ?? null);

  const statusOf = (row: ConnectionSecretRow | null, bound: boolean): ConnectionView["status"] => {
    if (row?.encryptedSecret) return row.status === "error" ? "error" : "configured";
    return bound ? "bound" : "unconfigured";
  };

  return [
    {
      type: "figma",
      status: statusOf(figma, source !== null),
      statusMessage: figma?.statusMessage ?? null,
      secretTail: typeof figmaMeta.last4 === "string" ? `…${figmaMeta.last4}` : null,
      fileKey: source?.fileKey ?? null,
      fileName: source?.fileName ?? null,
      updatedAt: figma?.updatedAt ?? null,
    },
    {
      type: "slack",
      status: statusOf(slack, false),
      statusMessage: slack?.statusMessage ?? null,
      secretTail: typeof slackMeta.last4 === "string" ? `…${slackMeta.last4}` : null,
      fileKey: null,
      fileName: null,
      updatedAt: slack?.updatedAt ?? null,
    },
  ];
}

async function sealFor(c: Context<AppEnv>, plaintext: string): Promise<{ ciphertext: string; iv: string } | null> {
  if (!c.env.SECRETS_KEY) return null;
  const key = await importSecretsKey(c.env.SECRETS_KEY);
  return sealSecret(plaintext, key);
}

async function readDeprecation(db: D1Database, id: string): Promise<DeprecationRow | null> {
  return db
    .prepare(
      "SELECT id, name, type, reason, since, removeBy, createdAt FROM deprecations WHERE id = ?",
    )
    .bind(id)
    .first<DeprecationRow>();
}

export function dashboard(): Hono<AppEnv> {
  const d = new Hono<AppEnv>();

  d.get("/projects", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const projects = await db
      .prepare("SELECT id, name, slug, createdAt FROM projects WHERE workspaceId = ? ORDER BY createdAt DESC")
      .bind(workspace.id)
      .all<ProjectRow>();

    const entries = await Promise.all(
      projects.results.map(async (project) => {
        const status = await readStatus(db, project.id);
        const newest = await db
          .prepare(
            "SELECT kind, receivedAt FROM snapshots WHERE projectId = ? ORDER BY receivedAt DESC, rowid DESC LIMIT 1",
          )
          .bind(project.id)
          .first<{ kind: string; receivedAt: string }>();
        const codeSnapshot = await db
          .prepare(
            "SELECT payload FROM snapshots WHERE projectId = ? AND kind = 'code' ORDER BY receivedAt DESC, rowid DESC LIMIT 1",
          )
          .bind(project.id)
          .first<{ payload: string }>();
        const source = await db
          .prepare("SELECT fileKey, fileName FROM figma_sources WHERE projectId = ?")
          .bind(project.id)
          .first<{ fileKey: string; fileName: string | null }>();

        let tokenCounts: { figma: number; code: number } | null = null;
        let componentCount: number | null = null;
        if (codeSnapshot) {
          try {
            const payload = JSON.parse(codeSnapshot.payload) as CodeSnapshotPayload;
            tokenCounts = {
              figma: payload.figmaTokens?.length ?? 0,
              code: payload.codeTokens?.length ?? 0,
            };
            componentCount = (payload.components ?? []).length;
          } catch {
            // An unreadable snapshot reads as "no counts", not a failed list call.
          }
        }

        return {
          id: project.id,
          name: project.name,
          slug: project.slug,
          createdAt: project.createdAt,
          state: status.state,
          checkedAt: status.checkedAt,
          counts: status.counts,
          lastActivity: newest?.receivedAt ?? project.createdAt,
          fileKey: source?.fileKey ?? null,
          fileName: source?.fileName ?? null,
          tokenCounts,
          componentCount,
        };
      }),
    );

    const summary = {
      total: entries.length,
      ok: 0,
      drift: 0,
      stale: 0,
      unknown: 0,
      lastCheckedAt: null as string | null,
    };
    for (const entry of entries) {
      summary[entry.state] += 1;
      if (summary.lastCheckedAt === null || entry.checkedAt > summary.lastCheckedAt) {
        summary.lastCheckedAt = entry.checkedAt;
      }
    }

    const trend = await workspaceTrend(db, workspace.id);
    return c.json({ workspace, summary, trend, projects: entries });
  });

  d.post("/projects", async (c) => {
    const body = await readBody(c);
    if (!body.ok) return body.response;
    const name = readString(body.value.name, 60);
    if (!name) {
      return fail(c, 400, "invalid_payload", "`name` must be a non-empty string of at most 60 characters.");
    }
    const workspace = await workspaceFor(c);
    let project: ProjectRow;
    try {
      project = await createProject(c.env.DB, workspace.id, name);
    } catch {
      return fail(c, 500, "server_error", "Could not create the project.");
    }
    await logAudit(c.env.DB, workspace.id, getSession(c).userId, "project.create", {
      projectId: project.id,
      name,
    });
    return c.json({ project }, 201);
  });

  d.get("/projects/:id", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");

    const status = await readStatus(db, project.id);

    let details: DriftDetails["result"] = null;
    let detailsError: string | null = null;
    let code: DriftDetails["code"] = null;
    let figma: DriftDetails["figma"] = null;
    let codeSnapshot: DriftDetails["codeSnapshot"] = null;
    let figmaSnapshot: DriftDetails["figmaSnapshot"] = null;
    try {
      const computed = await computeDriftDetails(db, project.id);
      details = computed.result;
      code = computed.code;
      figma = computed.figma;
      codeSnapshot = computed.codeSnapshot;
      figmaSnapshot = computed.figmaSnapshot;
    } catch (error) {
      detailsError = error instanceof Error ? error.message : String(error);
    }

    const counts = details ? countsFrom(details) : status.counts;

    const runs = await db
      .prepare(
        "SELECT state, counts, createdAt FROM drift_runs WHERE projectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?",
      )
      .bind(project.id, TREND_RUNS)
      .all<{ state: string; counts: string | null; createdAt: string }>();
    const trend = runs.results
      .reverse()
      .map((run) => ({ createdAt: run.createdAt, state: run.state, total: totalDrift(parseCounts(run.counts)) }));

    const source = await db
      .prepare("SELECT fileKey, fileName FROM figma_sources WHERE projectId = ?")
      .bind(project.id)
      .first<{ fileKey: string; fileName: string | null }>();

    return c.json({
      project,
      state: status.state,
      staleReason: status.staleReason,
      checkedAt: status.checkedAt,
      counts,
      details,
      detailsError,
      fileKey: source?.fileKey ?? null,
      fileName: source?.fileName ?? null,
      trend,
      latestCode:
        code && codeSnapshot
          ? {
              receivedAt: codeSnapshot.receivedAt,
              gitBranch: codeSnapshot.gitBranch,
              gitCommit: codeSnapshot.gitCommit,
              tokenCounts: { figma: code.figmaTokens?.length ?? 0, code: code.codeTokens?.length ?? 0 },
              componentCount: (code.components ?? []).length,
            }
          : null,
      latestFigma:
        figma && figmaSnapshot
          ? {
              receivedAt: figmaSnapshot.receivedAt,
              tokenCount: figma.tokens?.length ?? 0,
              componentCount: (figma.components ?? []).length,
            }
          : null,
    });
  });

  d.get("/projects/:id/deprecations", async (c) => {
    const workspace = await workspaceFor(c);
    const project = await findProject(c.env.DB, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const rows = await c.env.DB.prepare(
      "SELECT id, name, type, reason, since, removeBy, createdAt FROM deprecations WHERE projectId = ? ORDER BY name",
    )
      .bind(project.id)
      .all<DeprecationRow>();
    return c.json({ deprecations: rows.results });
  });

  d.post("/projects/:id/deprecations", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const body = await readBody(c);
    if (!body.ok) return body.response;

    const name = readString(body.value.name, 80);
    if (!name) {
      return fail(c, 400, "invalid_payload", "`name` must be a non-empty string of at most 80 characters.");
    }
    const type = body.value.type;
    if (type !== "token" && type !== "component") {
      return fail(c, 400, "invalid_payload", "`type` must be `token` or `component`.");
    }
    const reason = readOptionalText(body.value.reason, 200);
    if (reason === false) {
      return fail(c, 400, "invalid_payload", "`reason` must be a string of at most 200 characters.");
    }
    const since = readOptionalDate(body.value.since);
    const removeBy = readOptionalDate(body.value.removeBy);
    if (since === false || removeBy === false) {
      return fail(c, 400, "invalid_payload", "`since` and `removeBy` must be YYYY-MM-DD dates.");
    }

    const duplicate = await db
      .prepare("SELECT id FROM deprecations WHERE projectId = ? AND name = ? AND type = ?")
      .bind(project.id, name, type)
      .first<{ id: string }>();
    if (duplicate) {
      return fail(c, 400, "invalid_payload", "A deprecation for this name and type already exists.");
    }

    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO deprecations (id, projectId, name, type, reason, since, removeBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(id, project.id, name, type, reason, since, removeBy, new Date().toISOString())
      .run();
    await logAudit(db, workspace.id, getSession(c).userId, "deprecation.create", { projectId: project.id, id, name, type });
    return c.json({ deprecation: await readDeprecation(db, id) }, 201);
  });

  d.put("/projects/:id/deprecations/:depId", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const depId = c.req.param("depId");
    const existing = await db
      .prepare("SELECT id, name, type FROM deprecations WHERE id = ? AND projectId = ?")
      .bind(depId, project.id)
      .first<{ id: string; name: string; type: "token" | "component" }>();
    if (!existing) return fail(c, 404, "not_found", "No such deprecation.");
    const body = await readBody(c);
    if (!body.ok) return body.response;

    const updates: Record<string, string | null> = {};
    if ("name" in body.value) {
      const name = readString(body.value.name, 80);
      if (!name) return fail(c, 400, "invalid_payload", "`name` must be a non-empty string of at most 80 characters.");
      updates.name = name;
    }
    if ("type" in body.value) {
      const type = body.value.type;
      if (type !== "token" && type !== "component") {
        return fail(c, 400, "invalid_payload", "`type` must be `token` or `component`.");
      }
      updates.type = type;
    }
    if ("reason" in body.value) {
      const reason = readOptionalText(body.value.reason, 200);
      if (reason === false) {
        return fail(c, 400, "invalid_payload", "`reason` must be a string of at most 200 characters.");
      }
      updates.reason = reason;
    }
    for (const key of ["since", "removeBy"] as const) {
      if (key in body.value) {
        const date = readOptionalDate(body.value[key]);
        if (date === false) {
          return fail(c, 400, "invalid_payload", "`since` and `removeBy` must be YYYY-MM-DD dates.");
        }
        updates[key] = date;
      }
    }
    if (Object.keys(updates).length === 0) {
      return fail(c, 400, "invalid_payload", "Provide at least one field to update.");
    }

    const nextName = updates.name ?? existing.name;
    const nextType = (updates.type ?? existing.type) as "token" | "component";
    if (nextName !== existing.name || nextType !== existing.type) {
      const duplicate = await db
        .prepare("SELECT id FROM deprecations WHERE projectId = ? AND name = ? AND type = ? AND id != ?")
        .bind(project.id, nextName, nextType, depId)
        .first<{ id: string }>();
      if (duplicate) {
        return fail(c, 400, "invalid_payload", "A deprecation for this name and type already exists.");
      }
    }

    const keys = Object.keys(updates);
    await db
      .prepare(`UPDATE deprecations SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .bind(...keys.map((key) => updates[key]), depId)
      .run();
    await logAudit(db, workspace.id, getSession(c).userId, "deprecation.update", {
      projectId: project.id,
      id: depId,
      fields: keys,
    });
    return c.json({ deprecation: await readDeprecation(db, depId) });
  });

  d.delete("/projects/:id/deprecations/:depId", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const depId = c.req.param("depId");
    const result = await db
      .prepare("DELETE FROM deprecations WHERE id = ? AND projectId = ?")
      .bind(depId, project.id)
      .run();
    if (result.meta.changes === 0) return fail(c, 404, "not_found", "No such deprecation.");
    await logAudit(db, workspace.id, getSession(c).userId, "deprecation.delete", { projectId: project.id, id: depId });
    return c.json({ ok: true });
  });

  d.get("/projects/:id/connections", async (c) => {
    const workspace = await workspaceFor(c);
    const project = await findProject(c.env.DB, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    return c.json({ connections: await connectionViews(c.env.DB, project.id) });
  });

  d.put("/projects/:id/connections/:type", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const type = c.req.param("type");
    if (type !== "figma" && type !== "slack") return fail(c, 404, "not_found", "Unknown connection type.");
    const body = await readBody(c);
    if (!body.ok) return body.response;

    const existing = await readConnection(db, project.id, type);
    const meta = parseMeta(existing?.meta ?? null);
    let encryptedSecret = existing?.encryptedSecret ?? null;
    let iv = existing?.iv ?? null;

    if (type === "slack") {
      const secret = readString(body.value.secret, 500);
      if (!secret) return fail(c, 400, "invalid_payload", "`secret` must be a non-empty string.");
      const sealed = await sealFor(c, secret);
      if (!sealed) return fail(c, 500, "server_error", "SECRETS_KEY is not configured on the server.");
      encryptedSecret = sealed.ciphertext;
      iv = sealed.iv;
      meta.last4 = secret.slice(-4);
    } else {
      const hasFileKey = "fileKey" in body.value;
      const fileKey = hasFileKey ? readString(body.value.fileKey, 200) : null;
      if (hasFileKey && !fileKey) {
        return fail(c, 400, "invalid_payload", "`fileKey` must be a non-empty string of at most 200 characters.");
      }
      let secret: string | null = null;
      if ("secret" in body.value) {
        secret = readString(body.value.secret, 500);
        if (!secret) return fail(c, 400, "invalid_payload", "`secret` must be a non-empty string.");
      }
      if (!fileKey && !secret) {
        return fail(c, 400, "invalid_payload", "Provide `fileKey` and/or `secret`.");
      }
      if (secret) {
        const sealed = await sealFor(c, secret);
        if (!sealed) return fail(c, 500, "server_error", "SECRETS_KEY is not configured on the server.");
        encryptedSecret = sealed.ciphertext;
        iv = sealed.iv;
        meta.last4 = secret.slice(-4);
      }
      if (fileKey) {
        const fileName = "fileName" in body.value ? readString(body.value.fileName, 200) : null;
        await db
          .prepare(
            `INSERT INTO figma_sources (projectId, fileKey, fileName) VALUES (?, ?, ?)
             ON CONFLICT(projectId) DO UPDATE SET fileKey = excluded.fileKey,
               fileName = COALESCE(excluded.fileName, figma_sources.fileName)`,
          )
          .bind(project.id, fileKey, fileName)
          .run();
        meta.fileKey = fileKey;
      }
    }

    const source = await db
      .prepare("SELECT fileKey FROM figma_sources WHERE projectId = ?")
      .bind(project.id)
      .first<{ fileKey: string }>();
    const status = encryptedSecret ? "configured" : source ? "bound" : "unconfigured";
    await upsertConnection(db, project.id, type, encryptedSecret, iv, meta, status);
    await logAudit(db, workspace.id, getSession(c).userId, "connection.update", { projectId: project.id, type });

    const views = await connectionViews(db, project.id);
    return c.json({ connection: views.find((view) => view.type === type) });
  });

  d.delete("/projects/:id/connections/:type", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const type = c.req.param("type");
    if (type !== "figma" && type !== "slack") return fail(c, 404, "not_found", "Unknown connection type.");

    const now = new Date().toISOString();
    const clear = db
      .prepare(
        "UPDATE connections SET encryptedSecret = NULL, iv = NULL, meta = NULL, status = 'unconfigured', updatedAt = ? WHERE projectId = ? AND type = ?",
      )
      .bind(now, project.id, type);
    if (type === "figma") {
      await db.batch([
        db.prepare("DELETE FROM figma_sources WHERE projectId = ?").bind(project.id),
        clear,
      ]);
    } else {
      await clear.run();
    }
    await logAudit(db, workspace.id, getSession(c).userId, "connection.clear", { projectId: project.id, type });

    const views = await connectionViews(db, project.id);
    return c.json({ connection: views.find((view) => view.type === type) });
  });

  d.post("/projects/:id/connections/slack/test", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");

    const conn = await readConnection(db, project.id, "slack");
    if (!conn?.encryptedSecret || !conn.iv) {
      return fail(c, 400, "not_configured", "Connect Slack before sending a test message.");
    }
    if (!c.env.SECRETS_KEY) {
      return fail(c, 500, "server_error", "SECRETS_KEY is not configured on the server.");
    }

    let webhookUrl: string;
    try {
      const key = await importSecretsKey(c.env.SECRETS_KEY);
      webhookUrl = await openSecret({ ciphertext: conn.encryptedSecret, iv: conn.iv }, key);
    } catch {
      return fail(c, 500, "server_error", "The stored webhook can't be decrypted — replace it in Connections.");
    }

    const origin = c.env.CONSOLE_ORIGIN;
    const message = buildSlackTestMessage(project.name, origin ? `${origin}/#/p/${project.id}` : undefined);
    const now = new Date().toISOString();
    try {
      await postSlackMessage(webhookUrl, message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await db
        .prepare("UPDATE connections SET status = 'error', statusMessage = ?, updatedAt = ? WHERE projectId = ? AND type = 'slack'")
        .bind(reason.slice(0, 200), now, project.id)
        .run();
      return fail(c, 502, "slack_error", "Slack refused the test message.", { detail: reason.slice(0, 200) });
    }

    await db
      .prepare("UPDATE connections SET status = 'configured', statusMessage = NULL, updatedAt = ? WHERE projectId = ? AND type = 'slack'")
      .bind(now, project.id)
      .run();
    await logAudit(db, workspace.id, getSession(c).userId, "slack.test", { projectId: project.id });
    return c.json({ ok: true });
  });

  d.get("/projects/:id/notification-rules", async (c) => {
    const workspace = await workspaceFor(c);
    const project = await findProject(c.env.DB, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    return c.json({ rules: await readNotificationRules(c.env.DB, project.id) });
  });

  d.put("/projects/:id/notification-rules", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const body = await readBody(c);
    if (!body.ok) return body.response;

    const current = await readNotificationRules(db, project.id);
    let mode = current.mode;
    if ("mode" in body.value) {
      const value = body.value.mode;
      if (value !== "change" && value !== "always" && value !== "never") {
        return fail(c, 400, "invalid_payload", "`mode` must be `change`, `always` or `never`.");
      }
      mode = value as NotificationMode;
    }
    let overdueAlways = current.overdueAlways;
    if ("overdueAlways" in body.value) {
      if (typeof body.value.overdueAlways !== "boolean") {
        return fail(c, 400, "invalid_payload", "`overdueAlways` must be a boolean.");
      }
      overdueAlways = body.value.overdueAlways;
    }
    if (!("mode" in body.value) && !("overdueAlways" in body.value)) {
      return fail(c, 400, "invalid_payload", "Provide `mode` and/or `overdueAlways`.");
    }

    await writeNotificationRules(db, project.id, { mode, overdueAlways });
    await logAudit(db, workspace.id, getSession(c).userId, "notifications.update", { projectId: project.id, mode, overdueAlways });
    return c.json({ rules: await readNotificationRules(db, project.id) });
  });

  d.get("/projects/:id/tokens", async (c) => {
    const workspace = await workspaceFor(c);
    const project = await findProject(c.env.DB, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const rows = await c.env.DB.prepare(
      "SELECT id, kind, label, last4, createdAt, lastUsedAt, revokedAt FROM tokens WHERE projectId = ? ORDER BY createdAt DESC",
    )
      .bind(project.id)
      .all<{ id: string; kind: TokenKind; label: string | null; last4: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }>();
    return c.json({ tokens: rows.results });
  });

  d.post("/projects/:id/tokens", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const body = await readBody(c);
    if (!body.ok) return body.response;

    const kind = body.value.kind;
    if (kind !== "push" && kind !== "plugin") {
      return fail(c, 400, "invalid_payload", "`kind` must be `push` or `plugin`.");
    }
    let label: string | null = null;
    if ("label" in body.value) {
      const value = readOptionalText(body.value.label, 60);
      if (value === false) return fail(c, 400, "invalid_payload", "`label` must be at most 60 characters.");
      label = value;
    }

    const issued = await createToken(db, project.id, kind, label ?? undefined);
    await logAudit(db, workspace.id, getSession(c).userId, "token.issue", {
      projectId: project.id,
      tokenId: issued.tokenId,
      kind,
      last4: issued.last4,
    });
    return c.json(
      {
        /** Shown exactly once — only the hash and last4 are stored. */
        token: issued.token,
        tokenInfo: {
          id: issued.tokenId,
          kind: issued.kind,
          label,
          last4: issued.last4,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
      },
      201,
    );
  });

  d.post("/projects/:id/tokens/:tokenId/revoke", async (c) => {
    const db = c.env.DB;
    const workspace = await workspaceFor(c);
    const project = await findProject(db, workspace.id, c.req.param("id"));
    if (!project) return fail(c, 404, "not_found", "No such project.");
    const tokenId = c.req.param("tokenId");
    const result = await db
      .prepare("UPDATE tokens SET revokedAt = ? WHERE id = ? AND projectId = ? AND revokedAt IS NULL")
      .bind(new Date().toISOString(), tokenId, project.id)
      .run();
    if (result.meta.changes === 0) return fail(c, 404, "not_found", "No such active token.");
    await logAudit(db, workspace.id, getSession(c).userId, "token.revoke", { projectId: project.id, tokenId });
    return c.json({ ok: true });
  });

  d.get("/workspace", async (c) => {
    const workspace = await workspaceFor(c);
    const members = await c.env.DB.prepare(
      "SELECT userId, role, createdAt FROM members WHERE workspaceId = ? ORDER BY createdAt",
    )
      .bind(workspace.id)
      .all<{ userId: string; role: string; createdAt: string }>();
    return c.json({ workspace, members: members.results });
  });

  d.get("/activity", async (c) => {
    const workspace = await workspaceFor(c);
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;
    const before = c.req.query("before") ?? null;
    if (before !== null && Number.isNaN(Date.parse(before))) {
      return fail(c, 400, "invalid_payload", "`before` must be an ISO timestamp.");
    }

    const rows = await c.env.DB.prepare(
      `SELECT id, actor, action, detail, createdAt FROM audit_log
       WHERE workspaceId = ?${before ? " AND createdAt < ?" : ""}
       ORDER BY createdAt DESC, rowid DESC LIMIT ?`,
    )
      .bind(...(before ? [workspace.id, before, limit + 1] : [workspace.id, limit + 1]))
      .all<{ id: string; actor: string; action: string; detail: string | null; createdAt: string }>();

    const hasMore = rows.results.length > limit;
    const page = rows.results.slice(0, limit);

    const projectIds = new Set<string>();
    for (const row of page) {
      const detail = parseMeta(row.detail);
      if (typeof detail.projectId === "string") projectIds.add(detail.projectId);
    }
    const projectNames = new Map<string, string>();
    if (projectIds.size > 0) {
      const placeholders = [...projectIds].map(() => "?").join(", ");
      const projects = await c.env.DB.prepare(
        `SELECT id, name FROM projects WHERE workspaceId = ? AND id IN (${placeholders})`,
      )
        .bind(workspace.id, ...projectIds)
        .all<{ id: string; name: string }>();
      for (const project of projects.results) projectNames.set(project.id, project.name);
    }

    return c.json({
      entries: page.map((row) => {
        const detail = parseMeta(row.detail);
        const projectId = typeof detail.projectId === "string" ? detail.projectId : null;
        return {
          id: row.id,
          actor: row.actor,
          action: row.action,
          detail: row.detail === null ? null : detail,
          createdAt: row.createdAt,
          project: projectId && projectNames.has(projectId) ? { id: projectId, name: projectNames.get(projectId) } : null,
        };
      }),
      hasMore,
    });
  });

  return d;
}
