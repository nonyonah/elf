import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createToken } from "../src/db/tokens.js";
import { createApp } from "../src/index.js";
import { runDueJobs } from "../src/jobs.js";

const app = createApp();

interface SeededProject {
  projectId: string;
  pushToken: string;
  pluginToken: string;
}

async function seedProject(): Promise<SeededProject> {
  const workspaceId = `ws_${crypto.randomUUID()}`;
  const projectId = `prj_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)")
    .bind(workspaceId, "Test workspace", now)
    .run();
  await env.DB.prepare("INSERT INTO projects (id, workspaceId, name, slug, createdAt) VALUES (?, ?, ?, ?, ?)")
    .bind(projectId, workspaceId, "Test project", `test-${crypto.randomUUID().slice(0, 8)}`, now)
    .run();
  const push = await createToken(env.DB, projectId, "push");
  const plugin = await createToken(env.DB, projectId, "plugin");
  return { projectId, pushToken: push.token, pluginToken: plugin.token };
}

interface V1Init {
  method?: string;
  token?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function v1(path: string, init: V1Init = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return await app.request(
    `/api/v1${path}`,
    { method: init.method ?? "GET", headers, ...(init.body === undefined ? {} : { body: init.body }) },
    env,
  );
}

function codePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "cli",
    checkedAt: "2026-10-17T12:00:00Z",
    git: { branch: "main", commit: "8f3c1a9" },
    config: {
      figmaFileKey: "abc123",
      figmaSource: "variables",
      codebaseSource: "tailwind",
      modeStrategy: "modes",
      modeName: null,
    },
    figmaTokens: [{ name: "accent-500", category: "color", value: "#6366f1" }],
    codeTokens: [{ name: "accent-500", category: "color", value: "#6366f1" }],
    drift: { found: false, counts: {} },
    ...overrides,
  });
}

async function ingestCode(project: SeededProject, body = codePayload()): Promise<Response> {
  return v1("/ingest/code", { method: "POST", token: project.pushToken, body });
}

describe("contract v1 surface", () => {
  it("serves /api/v1/health without auth", async () => {
    const response = await v1("/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, schema: 1, version: "1.0.0" });
  });

  it("rejects missing, unknown, revoked and wrong-kind tokens with 401", async () => {
    const project = await seedProject();

    const missing = await v1("/projects/me/status");
    expect(missing.status).toBe(401);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const unknown = await v1("/projects/me/status", { token: "elf_push_definitely-not-real" });
    expect(unknown.status).toBe(401);

    const pluginOnCode = await v1("/ingest/code", {
      method: "POST",
      token: project.pluginToken,
      body: codePayload(),
    });
    expect(pluginOnCode.status).toBe(401);

    const pushOnFigma = await v1("/ingest/figma", {
      method: "POST",
      token: project.pushToken,
      body: JSON.stringify({ figma: { fileKey: "abc123" }, capturedAt: "2026-10-17T12:00:00Z", tokens: [] }),
    });
    expect(pushOnFigma.status).toBe(401);

    await env.DB.prepare("UPDATE tokens SET revokedAt = ? WHERE hash = (SELECT hash FROM tokens WHERE projectId = ? AND kind = 'push' LIMIT 1)")
      .bind(new Date().toISOString(), project.projectId)
      .run();
    const revoked = await v1("/projects/me/status", { token: project.pushToken });
    expect(revoked.status).toBe(401);
  });

  it("stores a code snapshot: row, figma binding, debounced drift job, 202", async () => {
    const project = await seedProject();
    const response = await ingestCode(project);
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; snapshotId: string; receivedAt: string };
    expect(body.status).toBe("stored");
    expect(body.snapshotId.startsWith("snap_")).toBe(true);
    expect(Number.isNaN(Date.parse(body.receivedAt))).toBe(false);

    const snapshot = await env.DB.prepare("SELECT kind, source, gitBranch, gitCommit FROM snapshots WHERE projectId = ?")
      .bind(project.projectId)
      .first<{ kind: string; source: string; gitBranch: string; gitCommit: string }>();
    expect(snapshot).toMatchObject({ kind: "code", source: "cli", gitBranch: "main", gitCommit: "8f3c1a9" });

    const source = await env.DB.prepare("SELECT fileKey FROM figma_sources WHERE projectId = ?")
      .bind(project.projectId)
      .first<{ fileKey: string }>();
    expect(source?.fileKey).toBe("abc123");

    const job = await env.DB.prepare("SELECT type, notBefore, attempts FROM jobs WHERE projectId = ?")
      .bind(project.projectId)
      .first<{ type: string; notBefore: string; attempts: number }>();
    expect(job?.type).toBe("drift");
    expect(job?.attempts).toBe(0);
    const delta = Date.parse(job!.notBefore) - Date.now();
    expect(delta).toBeGreaterThan(8_000);
    expect(delta).toBeLessThan(12_000);
  });

  it("dedupes an identical payload and counts secrets-free failures plainly", async () => {
    const project = await seedProject();
    const first = (await (await ingestCode(project)).json()) as { snapshotId: string };
    const second = await ingestCode(project);
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { status: string; snapshotId: string };
    expect(secondBody.status).toBe("deduped");
    expect(secondBody.snapshotId).toBe(first.snapshotId);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE projectId = ?")
      .bind(project.projectId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("rejects invalid payloads with 400 invalid_payload and details.issues", async () => {
    const project = await seedProject();

    const missingCheckedAt = await ingestCode(
      project,
      codePayload({ checkedAt: undefined }),
    );
    expect(missingCheckedAt.status).toBe(400);
    const missingBody = (await missingCheckedAt.json()) as { error: { code: string; details: { issues: string[] } } };
    expect(missingBody.error.code).toBe("invalid_payload");
    expect(missingBody.error.details.issues.join(" ")).toContain("checkedAt");

    const badSource = await ingestCode(project, codePayload({ source: "sneaky" }));
    expect(badSource.status).toBe(400);

    const badTokens = await ingestCode(project, codePayload({ codeTokens: [{ name: "x" }] }));
    expect(badTokens.status).toBe(400);

    const notJson = await v1("/ingest/code", { method: "POST", token: project.pushToken, body: "not json at all" });
    expect(notJson.status).toBe(400);
  });

  it("rejects bodies over 2 MB with 413 too_large", async () => {
    const project = await seedProject();
    const response = await ingestCode(project, codePayload({ report: "x".repeat(2 * 1024 * 1024 + 100) }));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("too_large");
  });

  it("rate limits at 60 requests per minute per token, and only per token", async () => {
    const project = await seedProject();
    const other = await seedProject();

    for (let i = 0; i < 60; i += 1) {
      const response = await v1("/projects/me/status", { token: project.pushToken });
      expect(response.status).toBe(200);
    }

    const limited = await v1("/projects/me/status", { token: project.pushToken });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);

    const unaffected = await v1("/projects/me/status", { token: other.pushToken });
    expect(unaffected.status).toBe(200);
  });
});

describe("drift runs and status", () => {
  it("recomputes token drift on the job, honors deprecations, and reports via status", async () => {
    const project = await seedProject();

    // D1 storage is shared across tests in this file — drain stale jobs first
    // so the processed count below refers to this project's job only.
    await env.DB.prepare("DELETE FROM jobs").run();

    await ingestCode(
      project,
      codePayload({
        figmaTokens: [
          { name: "accent-500", category: "color", value: "#6366f1" },
          { name: "brand", category: "color", value: "#111111" },
        ],
        codeTokens: [
          { name: "accent-500", category: "color", value: "#4f46e5" },
          { name: "legacy-slate", category: "color", value: "#999999" },
        ],
      }),
    );
    // legacy-slate: gone from Figma, still in code, overdue — counts as drift.
    await env.DB.prepare(
      "INSERT INTO deprecations (id, projectId, name, type, reason, since, removeBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        project.projectId,
        "legacy-slate",
        "token",
        "sunset palette",
        "2026-01-01",
        "2026-02-01",
        new Date().toISOString(),
      )
      .run();

    const processed = await runDueJobs(env, new Date(Date.now() + 20_000));
    expect(processed).toBe(1);

    const run = await env.DB.prepare(
      "SELECT state, counts, triggeredBy, error FROM drift_runs WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1",
    )
      .bind(project.projectId)
      .first<{ state: string; counts: string; triggeredBy: string; error: string | null }>();
    expect(run?.state).toBe("drift");
    expect(run?.triggeredBy).toBe("job");
    expect(run?.error).toBeNull();
    const counts = JSON.parse(run!.counts) as Record<string, number>;
    expect(counts.valueMismatches).toBe(1);
    expect(counts.deprecationOverdue).toBe(1);
    expect(counts.missingInFigma).toBe(0);

    const status = await v1("/projects/me/status", { token: project.pushToken });
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as {
      state: string;
      counts: Record<string, number>;
      reportUrl: string;
      checkedAt: string;
    };
    expect(statusBody.state).toBe("drift");
    expect(statusBody.counts.valueMismatches).toBe(1);
    expect(statusBody.reportUrl).toContain(`/projects/${project.projectId}`);

    // Clear the deprecation and push a clean snapshot — the next run is ok.
    await env.DB.prepare("DELETE FROM deprecations WHERE projectId = ?").bind(project.projectId).run();
    await ingestCode(
      project,
      codePayload({
        figmaTokens: [
          { name: "accent-500", category: "color", value: "#6366f1" },
          { name: "brand", category: "color", value: "#111111" },
        ],
        codeTokens: [
          { name: "accent-500", category: "color", value: "#6366f1" },
          { name: "brand", category: "color", value: "#111111" },
        ],
      }),
    );
    await runDueJobs(env, new Date(Date.now() + 20_000));

    const okStatus = await v1("/projects/me/status", { token: project.pushToken });
    const okBody = (await okStatus.json()) as { state: string; counts: Record<string, number> };
    expect(okBody.state).toBe("ok");
    expect(okBody.counts.valueMismatches).toBe(0);
  });

  it("uses Figma snapshots for component recompute (changed in Figma)", async () => {
    const project = await seedProject();

    await ingestCode(
      project,
      codePayload({
        components: [
          { name: "Button", codeKey: "src/components/Button.tsx", specHash: "spec-1", nodeHash: "node-1" },
        ],
      }),
    );

    const figma = await v1("/ingest/figma", {
      method: "POST",
      token: project.pluginToken,
      body: JSON.stringify({
        figma: { fileKey: "abc123", fileName: "Design System" },
        capturedAt: "2026-10-17T12:00:10Z",
        tokens: [{ name: "accent-500", value: "#6366f1", type: "COLOR", mode: "Light" }],
        components: [{ name: "Button", codeKey: "src/components/Button.tsx", nodeHash: "node-2" }],
        pluginVersion: "1.0.0",
      }),
    });
    expect(figma.status).toBe(202);

    const source = await env.DB.prepare("SELECT fileName FROM figma_sources WHERE projectId = ?")
      .bind(project.projectId)
      .first<{ fileName: string }>();
    expect(source?.fileName).toBe("Design System");

    await runDueJobs(env, new Date(Date.now() + 20_000));
    const run = await env.DB.prepare(
      "SELECT state, counts FROM drift_runs WHERE projectId = ? ORDER BY createdAt DESC LIMIT 1",
    )
      .bind(project.projectId)
      .first<{ state: string; counts: string }>();
    expect(run?.state).toBe("drift");
    const counts = JSON.parse(run!.counts) as Record<string, number>;
    expect(counts.componentsChangedInFigma).toBe(1);
    expect(counts.valueMismatches).toBe(0);
  });
});

describe("remote config", () => {
  it("serves the schema-1 envelope with ETag, If-None-Match and deprecation updates", async () => {
    const project = await seedProject();

    const first = await v1("/projects/me/config", { token: project.pushToken });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      schema: number;
      config: { deprecations: unknown[]; nameMapping: Record<string, string> };
      updatedAt: string;
      etag: string;
    };
    expect(firstBody.schema).toBe(1);
    expect(firstBody.config.deprecations).toEqual([]);
    expect(firstBody.config.nameMapping).toEqual({});
    expect(first.headers.get("ETag")).toBe(firstBody.etag);
    expect(Number.isNaN(Date.parse(firstBody.updatedAt))).toBe(false);

    const revalidated = await v1("/projects/me/config", {
      token: project.pushToken,
      headers: { "If-None-Match": firstBody.etag },
    });
    expect(revalidated.status).toBe(304);

    await env.DB.prepare(
      "INSERT INTO deprecations (id, projectId, name, type, reason, since, removeBy, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), project.projectId, "legacy-blue", "token", "sunset palette", "2026-01-01", "2026-06-01", new Date().toISOString())
      .run();

    const second = await v1("/projects/me/config", { token: project.pushToken });
    const secondBody = (await second.json()) as { config: { deprecations: { name: string }[] }; etag: string };
    expect(secondBody.config.deprecations).toHaveLength(1);
    expect(secondBody.config.deprecations[0].name).toBe("legacy-blue");
    expect(secondBody.etag).not.toBe(firstBody.etag);
  });
});

describe("tenant isolation", () => {
  it("scopes everything to the token's own project", async () => {
    const alice = await seedProject();
    const bob = await seedProject();

    await ingestCode(alice);
    await runDueJobs(env, new Date(Date.now() + 20_000));

    const bobStatus = await v1("/projects/me/status", { token: bob.pushToken });
    const bobBody = (await bobStatus.json()) as { state: string; counts: Record<string, number> };
    expect(bobBody.state).toBe("unknown");
    expect(bobBody.counts.valueMismatches).toBe(0);

    const bobSnapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE projectId = ?")
      .bind(bob.projectId)
      .first<{ n: number }>();
    expect(bobSnapshots?.n).toBe(0);

    const aliceSnapshots = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshots WHERE projectId = ?")
      .bind(alice.projectId)
      .first<{ n: number }>();
    expect(aliceSnapshots?.n).toBe(1);
  });
});
