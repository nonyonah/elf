/**
 * The CONTRACT.md schema-1 API: /api/v1/*, bearer-token scoped per project.
 * Every endpoint except /health resolves the token first, then rate-limits
 * (60/min/token), then checks the token kind the endpoint requires.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import {
  CONTRACT_SCHEMA,
  CONTRACT_VERSION,
  MAX_BODY_BYTES,
  canonicalJson,
  errorJson,
  validateCodePayload,
  validateFigmaPayload,
} from "./contract.js";
import { resolveToken, type ResolvedToken, type TokenKind } from "./db/tokens.js";
import { readStatus } from "./drift.js";
import type { Env } from "./env.js";
import { enqueueDriftJob, kickDeferredJobs } from "./jobs.js";
import { takeRateLimit } from "./ratelimit.js";
import { sha256Hex } from "elf-tokens/core";

export type ApiEnv = { Bindings: Env; Variables: { project: ResolvedToken } };

type Handler = (c: Context<ApiEnv>) => Promise<Response> | Response;

function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function requireKind(kind: TokenKind, handler: Handler): Handler {
  return async (c) => {
    if (c.get("project").kind !== kind) {
      return errorJson(c, 401, "unauthorized", "This token cannot call this endpoint.");
    }
    return handler(c);
  };
}

/** 2 MB cap enforced on the declared header and again on the actual bytes. */
async function readJsonBody(c: Context<ApiEnv>): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false, response: errorJson(c, 413, "too_large", "The body is larger than 2 MB.") };
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, response: errorJson(c, 413, "too_large", "The body is larger than 2 MB.") };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: errorJson(c, 400, "invalid_payload", "The body must be valid JSON.") };
  }
}

interface StoreOptions {
  kind: "code" | "figma";
  source: string;
  git?: { branch: string; commit: string };
  payload: unknown;
  /** Figma binding carried by code snapshots (config.figmaFileKey). */
  fileKey?: string;
  fileName?: string;
}

async function storeSnapshot(c: Context<ApiEnv>, options: StoreOptions): Promise<Response> {
  const db = c.env.DB;
  const projectId = c.get("project").projectId;
  const canonical = canonicalJson(options.payload);
  const contentHash = sha256Hex(canonical);

  const duplicate = await db
    .prepare(
      "SELECT id, receivedAt FROM snapshots WHERE projectId = ? AND kind = ? AND contentHash = ? ORDER BY receivedAt DESC LIMIT 1",
    )
    .bind(projectId, options.kind, contentHash)
    .first<{ id: string; receivedAt: string }>();
  if (duplicate) {
    return c.json(
      { status: "deduped", snapshotId: duplicate.id, receivedAt: duplicate.receivedAt },
      202,
    );
  }

  const snapshotId = `snap_${crypto.randomUUID()}`;
  const receivedAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO snapshots (id, projectId, kind, source, contentHash, payload, gitBranch, gitCommit, receivedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      snapshotId,
      projectId,
      options.kind,
      options.source,
      contentHash,
      canonical,
      options.git?.branch ?? null,
      options.git?.commit ?? null,
      receivedAt,
    )
    .run();

  if (options.kind === "figma") {
    await db
      .prepare(
        `INSERT INTO figma_sources (projectId, fileKey, fileName) VALUES (?, ?, ?)
         ON CONFLICT(projectId) DO UPDATE SET fileKey = excluded.fileKey, fileName = excluded.fileName`,
      )
      .bind(projectId, options.fileKey ?? "", options.fileName ?? null)
      .run();
  } else if (options.fileKey) {
    await db
      .prepare(
        "INSERT INTO figma_sources (projectId, fileKey) VALUES (?, ?) ON CONFLICT(projectId) DO NOTHING",
      )
      .bind(projectId, options.fileKey)
      .run();
  }

  await enqueueDriftJob(db, projectId);
  try {
    c.executionCtx.waitUntil(kickDeferredJobs(db));
  } catch {
    // Unit tests and plain `app.request` have no executionCtx — the cron is the backstop.
  }

  return c.json({ status: "stored", snapshotId, receivedAt }, 202);
}

export function apiV1(): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>();

  // Public — registered before the token middleware.
  api.get("/health", (c) => c.json({ ok: true, schema: CONTRACT_SCHEMA, version: CONTRACT_VERSION }));

  api.use("*", async (c, next) => {
    const raw = bearerToken(c.req.header("Authorization"));
    const project = raw ? await resolveToken(c.env.DB, raw) : null;
    if (!project) return errorJson(c, 401, "unauthorized", "Missing, unknown or revoked token.");
    const verdict = await takeRateLimit(c.env.DB, project.tokenId);
    if (!verdict.allowed) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return errorJson(c, 429, "rate_limited", "Too many requests — slow down and retry later.");
    }
    c.set("project", project);
    await next();
  });

  api.post(
    "/ingest/code",
    requireKind("push", async (c) => {
      const body = await readJsonBody(c);
      if (!body.ok) return body.response;
      const parsed = validateCodePayload(body.value);
      if (!parsed.ok) {
        return errorJson(c, 400, "invalid_payload", "Body failed validation.", { issues: parsed.issues });
      }
      return storeSnapshot(c, {
        kind: "code",
        source: parsed.value.source,
        ...(parsed.value.git === undefined ? {} : { git: parsed.value.git }),
        payload: parsed.value,
        fileKey: parsed.value.config.figmaFileKey,
      });
    }),
  );

  api.post(
    "/ingest/figma",
    requireKind("plugin", async (c) => {
      const body = await readJsonBody(c);
      if (!body.ok) return body.response;
      const parsed = validateFigmaPayload(body.value);
      if (!parsed.ok) {
        return errorJson(c, 400, "invalid_payload", "Body failed validation.", { issues: parsed.issues });
      }
      return storeSnapshot(c, {
        kind: "figma",
        source: "plugin",
        payload: parsed.value,
        fileKey: parsed.value.figma.fileKey,
        ...(parsed.value.figma.fileName === undefined ? {} : { fileName: parsed.value.figma.fileName }),
      });
    }),
  );

  api.get(
    "/projects/me/config",
    requireKind("push", async (c) => {
      const db = c.env.DB;
      const projectId = c.get("project").projectId;
      const rows = await db
        .prepare(
          "SELECT name, type, reason, since, removeBy, createdAt FROM deprecations WHERE projectId = ? ORDER BY name",
        )
        .bind(projectId)
        .all<{ name: string; type: string; reason: string | null; since: string | null; removeBy: string | null; createdAt: string }>();

      // Schema 1: the dashboard owns deprecations and nameMapping only.
      // modeStrategy/modeName are not served (no console storage) — the local
      // file keeps them; CLI merge skips absent fields.
      const config = {
        deprecations: rows.results.map((row) => ({
          name: row.name,
          type: row.type,
          ...(row.reason === null ? {} : { reason: row.reason }),
          ...(row.since === null ? {} : { since: row.since }),
          ...(row.removeBy === null ? {} : { removeBy: row.removeBy }),
        })),
        nameMapping: {},
      };

      const etag = `"cfg-${sha256Hex(canonicalJson(config)).slice(0, 16)}"`;
      const ifNoneMatch = c.req.header("If-None-Match");
      if (
        ifNoneMatch &&
        ifNoneMatch
          .split(",")
          .map((candidate) => candidate.trim())
          .includes(etag)
      ) {
        c.header("ETag", etag);
        return c.body(null, 304);
      }

      const project = await db
        .prepare("SELECT createdAt FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ createdAt: string }>();
      const updatedAt =
        rows.results
          .map((row) => row.createdAt)
          .sort()
          .at(-1) ?? project?.createdAt ?? new Date(0).toISOString();

      return c.json({ schema: CONTRACT_SCHEMA, config, updatedAt, etag }, 200, { ETag: etag });
    }),
  );

  api.get(
    "/projects/me/status",
    requireKind("push", async (c) => {
      const status = await readStatus(c.env.DB, c.get("project").projectId);
      return c.json({
        state: status.state,
        checkedAt: status.checkedAt,
        counts: status.counts,
        reportUrl: `${new URL(c.req.url).origin}/projects/${c.get("project").projectId}`,
      });
    }),
  );

  return api;
}
