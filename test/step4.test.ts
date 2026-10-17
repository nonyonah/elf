/**
 * Step 4: polling, Slack notifications, tokens, activity and rules.
 *
 * Notifications run through the real job pipeline (runDueJobs), with the
 * Slack webhook posted to a stubbed global fetch — the DB rows, the elf-core
 * message builder and the retry path are all exercised for real.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";
import { createToken } from "../src/db/tokens.js";
import { importSecretsKey, sealSecret } from "../src/db/crypto.js";
import { readStatus } from "../src/drift.js";
import { runDueJobs } from "../src/jobs.js";
import { pollFigmaSources } from "../src/poll.js";

const app = createApp({
  sessionResolver: async (request) => {
    const userId = request.headers.get("x-test-user");
    return userId ? { userId } : null;
  },
});

interface ApiInit {
  user?: string;
  method?: string;
  body?: unknown;
}

async function api(path: string, init: ApiInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.user) headers["x-test-user"] = init.user;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return await app.request(
    `/api${path}`,
    {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    env,
  );
}

function freshUser(): string {
  return `user_${crypto.randomUUID()}`;
}

async function seedProjectRow(): Promise<string> {
  const workspaceId = `ws_${crypto.randomUUID()}`;
  const projectId = `prj_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)")
    .bind(workspaceId, "Test workspace", now)
    .run();
  await env.DB.prepare("INSERT INTO projects (id, workspaceId, name, slug, createdAt) VALUES (?, ?, ?, ?, ?)")
    .bind(projectId, workspaceId, "Test project", `test-${crypto.randomUUID().slice(0, 8)}`, now)
    .run();
  return projectId;
}

async function seal(value: string): Promise<{ ciphertext: string; iv: string }> {
  if (!env.SECRETS_KEY) throw new Error("test env is missing SECRETS_KEY");
  const key = await importSecretsKey(env.SECRETS_KEY);
  return sealSecret(value, key);
}

async function connectSlack(projectId: string, webhookUrl: string): Promise<void> {
  const sealed = await seal(webhookUrl);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO connections (id, projectId, type, encryptedSecret, iv, meta, status, createdAt, updatedAt)
     VALUES (?, ?, 'slack', ?, ?, ?, 'configured', ?, ?)`,
  )
    .bind(crypto.randomUUID(), projectId, sealed.ciphertext, sealed.iv, JSON.stringify({ last4: webhookUrl.slice(-4) }), now, now)
    .run();
}

async function connectFigmaForPoll(projectId: string, figmaToken = "figd_test_token_1234"): Promise<void> {
  const sealed = await seal(figmaToken);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO connections (id, projectId, type, encryptedSecret, iv, meta, status, createdAt, updatedAt)
     VALUES (?, ?, 'figma', ?, ?, NULL, 'configured', ?, ?)`,
  )
    .bind(crypto.randomUUID(), projectId, sealed.ciphertext, sealed.iv, now, now)
    .run();
  await env.DB.prepare("INSERT INTO figma_sources (projectId, fileKey) VALUES (?, ?)")
    .bind(projectId, "FILEKEY1")
    .run();
}

function codeSnapshotJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    source: "cli",
    checkedAt: "2026-10-17T12:00:00Z",
    config: { figmaFileKey: "FILEKEY1", figmaSource: "variables (bridge)", codebaseSource: "tailwind" },
    figmaTokens: [{ name: "accent-500", category: "color", value: "#6366F1" }],
    codeTokens: [{ name: "accent-500", category: "color", value: "#EEEEEE" }],
    ...overrides,
  });
}

async function insertCodeSnapshot(projectId: string, payload = codeSnapshotJson()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO snapshots (id, projectId, kind, source, contentHash, payload, receivedAt)
     VALUES (?, ?, 'code', 'cli', ?, ?, ?)`,
  )
    .bind(`snap_${crypto.randomUUID()}`, projectId, crypto.randomUUID(), payload, new Date().toISOString())
    .run();
}

async function queueDrift(projectId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO jobs (id, projectId, type, notBefore, attempts, createdAt) VALUES (?, ?, 'drift', ?, 0, ?)",
  )
    .bind(crypto.randomUUID(), projectId, now, now)
    .run();
}

const future = (): Date => new Date(Date.now() + 20_000);

async function pendingNotifyJobs(projectId: string): Promise<Array<{ payload: string | null; attempts: number; lastError: string | null }>> {
  const rows = await env.DB.prepare(
    "SELECT payload, attempts, lastError FROM jobs WHERE projectId = ? AND type = 'notify' ORDER BY createdAt",
  )
    .bind(projectId)
    .all<{ payload: string | null; attempts: number; lastError: string | null }>();
  return rows.results;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollFigmaSources", () => {
  it("first poll records the version as a baseline without marking the project dirty", async () => {
    const projectId = await seedProjectRow();
    await connectFigmaForPoll(projectId);

    const outcome = await pollFigmaSources(
      env,
      new Date(),
      (async () => jsonResponse({ version: "v2", lastModified: "2026-10-17T10:00:00Z", name: "Demo file" })) as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ polled: 1, changed: 0, failed: 0 });

    const row = await env.DB.prepare(
      "SELECT lastVersion, lastModifiedAt, lastPolledAt, figmaDirtyAt, fileName FROM figma_sources WHERE projectId = ?",
    )
      .bind(projectId)
      .first<{ lastVersion: string; lastModifiedAt: string; lastPolledAt: string; figmaDirtyAt: string | null; fileName: string | null }>();
    expect(row?.lastVersion).toBe("v2");
    expect(row?.lastModifiedAt).toBe("2026-10-17T10:00:00Z");
    expect(row?.lastPolledAt).toBeTruthy();
    expect(row?.figmaDirtyAt).toBeNull();
    expect(row?.fileName).toBe("Demo file");
  });

  it("a newer version reads as stale until a fresh Figma snapshot lands", async () => {
    const projectId = await seedProjectRow();
    await connectFigmaForPoll(projectId);
    await env.DB.prepare("UPDATE figma_sources SET lastVersion = 'v2', lastPolledAt = NULL WHERE projectId = ?")
      .bind(projectId)
      .run();

    const outcome = await pollFigmaSources(
      env,
      new Date(),
      (async () => jsonResponse({ version: "v3", lastModified: "2026-10-17T11:00:00Z" })) as unknown as typeof fetch,
    );
    expect(outcome.changed).toBe(1);

    // A fresh, recorded run — staleness must come from the dirty marker alone.
    await insertCodeSnapshot(projectId);
    await env.DB.prepare(
      "INSERT INTO drift_runs (id, projectId, state, counts, triggeredBy, createdAt) VALUES (?, ?, 'ok', '{}', 'test', ?)",
    )
      .bind(crypto.randomUUID(), projectId, new Date().toISOString())
      .run();
    const status = await readStatus(env.DB, projectId);
    expect(status.state).toBe("stale");

    // The plugin lands a fresh Figma snapshot — the dirty marker clears.
    const plugin = await createToken(env.DB, projectId, "plugin");
    const response = await app.request(
      "/api/v1/ingest/figma",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${plugin.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          figma: { fileKey: "FILEKEY1", fileName: "Demo file" },
          capturedAt: new Date().toISOString(),
          tokens: [{ name: "accent-500", value: "#6366F1" }],
        }),
      },
      env,
    );
    expect(response.status).toBe(202);

    const cleared = await env.DB.prepare("SELECT figmaDirtyAt FROM figma_sources WHERE projectId = ?")
      .bind(projectId)
      .first<{ figmaDirtyAt: string | null }>();
    expect(cleared?.figmaDirtyAt).toBeNull();
    expect((await readStatus(env.DB, projectId)).state).not.toBe("stale");
  });

  it("permission errors land on the connection and a good poll clears them", async () => {
    const projectId = await seedProjectRow();
    await connectFigmaForPoll(projectId);

    const denied = await pollFigmaSources(env, new Date(), (async () => jsonResponse({ err: "forbidden" }, 403)) as unknown as typeof fetch);
    expect(denied.failed).toBe(1);
    let conn = await env.DB.prepare("SELECT status, statusMessage FROM connections WHERE projectId = ? AND type = 'figma'")
      .bind(projectId)
      .first<{ status: string; statusMessage: string | null }>();
    expect(conn?.status).toBe("error");
    expect(conn?.statusMessage).toMatch(/denied access/);

    await env.DB.prepare("UPDATE figma_sources SET lastPolledAt = NULL WHERE projectId = ?").bind(projectId).run();
    const ok = await pollFigmaSources(
      env,
      new Date(),
      (async () => jsonResponse({ version: "v2" })) as unknown as typeof fetch,
    );
    expect(ok.polled).toBe(1);
    conn = await env.DB.prepare("SELECT status, statusMessage FROM connections WHERE projectId = ? AND type = 'figma'")
      .bind(projectId)
      .first<{ status: string; statusMessage: string | null }>();
    expect(conn?.status).toBe("configured");
    expect(conn?.statusMessage).toBeNull();
  });

  it("skips files polled within the last interval", async () => {
    const projectId = await seedProjectRow();
    await connectFigmaForPoll(projectId);
    await pollFigmaSources(env, new Date(), (async () => jsonResponse({ version: "v2" })) as unknown as typeof fetch);

    const second = await pollFigmaSources(
      env,
      new Date(),
      (async () => jsonResponse({ version: "v9" })) as unknown as typeof fetch,
    );
    expect(second).toEqual({ polled: 0, changed: 0, failed: 0 });
  });
});

describe("Slack notifications", () => {
  const WEBHOOK = `https://hooks.slack.test/services/${crypto.randomUUID()}`;

  interface PostedMessage {
    url: string;
    body: {
      text: string;
      blocks?: Array<{ text?: { text: string }; elements?: Array<{ text: string }> }>;
    };
  }

  function stubSlackPost(status = 200): PostedMessage[] {
    const calls: PostedMessage[] = [];
    vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as PostedMessage["body"] });
      return new Response("ok", { status });
    });
    return calls;
  }

  async function seedDriftingProject(withSlack = true): Promise<string> {
    const projectId = await seedProjectRow();
    await insertCodeSnapshot(projectId);
    if (withSlack) await connectSlack(projectId, WEBHOOK);
    return projectId;
  }

  it("a first drifting run posts one message with a console link", async () => {
    const projectId = await seedDriftingProject();
    const calls = stubSlackPost();

    await queueDrift(projectId);
    await runDueJobs(env, future());
    const queued = await pendingNotifyJobs(projectId);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toContain('"reason":"first-report"');

    await runDueJobs(env, future());
    expect(await pendingNotifyJobs(projectId)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(WEBHOOK);
    expect(calls[0].body.blocks?.[0]?.text?.text).toBe("Design token drift detected");
    const context = calls[0].body.blocks?.[2]?.elements?.[0]?.text ?? "";
    expect(context).toContain(`<${env.CONSOLE_ORIGIN}/#/p/${projectId}|Open the report>`);
  });

  it("an unchanged result does not notify again", async () => {
    const projectId = await seedDriftingProject();
    const calls = stubSlackPost();

    await queueDrift(projectId);
    await runDueJobs(env, future());
    await runDueJobs(env, future());
    expect(calls).toHaveLength(1);

    await queueDrift(projectId);
    await runDueJobs(env, future());
    expect(await pendingNotifyJobs(projectId)).toHaveLength(0);
    await runDueJobs(env, future());
    expect(calls).toHaveLength(1);
  });

  it("mode never silences drift that would otherwise notify", async () => {
    const projectId = await seedDriftingProject();
    const calls = stubSlackPost();
    await env.DB.prepare("INSERT INTO notification_rules (projectId, mode, overdueAlways) VALUES (?, 'never', 0)")
      .bind(projectId)
      .run();

    await queueDrift(projectId);
    await runDueJobs(env, future());
    await runDueJobs(env, future());
    expect(calls).toHaveLength(0);
    expect(await pendingNotifyJobs(projectId)).toHaveLength(0);
  });

  it("overdue deprecations notify regardless of mode, unless overdueAlways is off", async () => {
    const projectId = await seedDriftingProject();
    const calls = stubSlackPost();
    await env.DB.prepare("INSERT INTO notification_rules (projectId, mode, overdueAlways) VALUES (?, 'never', 1)")
      .bind(projectId)
      .run();
    await env.DB.prepare(
      "INSERT INTO deprecations (id, projectId, name, type, reason, since, removeBy, createdAt) VALUES (?, ?, 'spacing-legacy', 'token', NULL, NULL, '2026-01-01', ?)",
    )
      .bind(crypto.randomUUID(), projectId, new Date().toISOString())
      .run();
    await insertCodeSnapshot(
      projectId,
      codeSnapshotJson({ codeTokens: [
        { name: "accent-500", category: "color", value: "#EEEEEE" },
        { name: "spacing-legacy", category: "spacing", value: "16px" },
      ] }),
    );

    await queueDrift(projectId);
    await runDueJobs(env, future());
    const queued = await pendingNotifyJobs(projectId);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toContain('"reason":"overdue"');

    await runDueJobs(env, future());
    expect(calls).toHaveLength(1);

    await env.DB.prepare("UPDATE notification_rules SET overdueAlways = 0 WHERE projectId = ?").bind(projectId).run();
    await queueDrift(projectId);
    await runDueJobs(env, future());
    expect(await pendingNotifyJobs(projectId)).toHaveLength(0);
    await runDueJobs(env, future());
    expect(calls).toHaveLength(1);
  });

  it("a refused webhook is retried with the same message", async () => {
    const projectId = await seedDriftingProject();
    stubSlackPost(500);

    await queueDrift(projectId);
    await runDueJobs(env, future());
    await runDueJobs(env, future());

    const retried = await pendingNotifyJobs(projectId);
    expect(retried).toHaveLength(1);
    expect(retried[0].attempts).toBe(1);
    expect(retried[0].lastError).toContain("500");
    expect(retried[0].payload).toContain("Design token drift detected");
  });
});

describe("tokens API", () => {
  it("issues show-once tokens, lists only tails, and revocation kills auth", async () => {
    const user = freshUser();
    const created = await api("/projects", { user, method: "POST", body: { name: "Tokens site" } });
    const { project } = (await created.json()) as { project: { id: string } };

    const issued = await api(`/projects/${project.id}/tokens`, { user, method: "POST", body: { kind: "push", label: "ci" } });
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as { token: string; tokenInfo: { id: string; last4: string } };
    expect(issuedBody.token.startsWith("elf_push_")).toBe(true);
    expect(issuedBody.token.endsWith(issuedBody.tokenInfo.last4)).toBe(true);
    expect(JSON.stringify(issuedBody)).not.toContain("hash");

    const listed = await api(`/projects/${project.id}/tokens`, { user });
    const listBody = (await listed.json()) as { tokens: Array<{ id: string; last4: string; revokedAt: string | null }> };
    expect(listBody.tokens).toHaveLength(1);
    expect(listBody.tokens[0].last4).toBe(issuedBody.tokenInfo.last4);
    expect(JSON.stringify(listBody)).not.toContain("hash");

    const status = await app.request(
      "/api/v1/projects/me/status",
      { headers: { Authorization: `Bearer ${issuedBody.token}` } },
      env,
    );
    expect(status.status).toBe(200);

    const revoked = await api(`/projects/${project.id}/tokens/${issuedBody.tokenInfo.id}/revoke`, { user, method: "POST" });
    expect(revoked.status).toBe(200);
    const afterRevoke = await app.request(
      "/api/v1/projects/me/status",
      { headers: { Authorization: `Bearer ${issuedBody.token}` } },
      env,
    );
    expect(afterRevoke.status).toBe(401);
  });

  it("rejects unknown kinds and keeps tokens tenant-scoped", async () => {
    const userA = freshUser();
    const userB = freshUser();
    const created = await api("/projects", { user: userA, method: "POST", body: { name: "Private site" } });
    const { project } = (await created.json()) as { project: { id: string } };

    const bad = await api(`/projects/${project.id}/tokens`, { user: userA, method: "POST", body: { kind: "admin" } });
    expect(bad.status).toBe(400);

    const foreign = await api(`/projects/${project.id}/tokens`, { user: userB });
    expect(foreign.status).toBe(404);
    const foreignIssue = await api(`/projects/${project.id}/tokens`, { user: userB, method: "POST", body: { kind: "push" } });
    expect(foreignIssue.status).toBe(404);
  });
});

describe("activity, rules and workspace", () => {
  it("lists audit entries with project names, newest first, and pages", async () => {
    const user = freshUser();
    const created = await api("/projects", { user, method: "POST", body: { name: "Activity site" } });
    const { project } = (await created.json()) as { project: { id: string } };
    await api(`/projects/${project.id}/tokens`, { user, method: "POST", body: { kind: "plugin" } });
    await api("/projects", { user, method: "POST", body: { name: "Second site" } });

    const response = await api("/activity?limit=2", { user });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{ action: string; actor: string; createdAt: string; project: { id: string; name: string } | null }>;
      hasMore: boolean;
    };
    expect(body.entries).toHaveLength(2);
    expect(body.hasMore).toBe(true);
    expect(body.entries[0].action).toBe("project.create");
    expect(body.entries[0].project?.name).toBe("Second site");
    expect(body.entries.every((entry) => entry.actor === user)).toBe(true);

    const paged = await api(`/activity?limit=2&before=${encodeURIComponent(body.entries[1].createdAt)}`, { user });
    expect(paged.status).toBe(200);
    const pagedBody = (await paged.json()) as { entries: Array<{ createdAt: string }> };
    expect(pagedBody.entries.every((entry) => entry.createdAt < body.entries[1].createdAt)).toBe(true);

    const all = await api("/activity?limit=100", { user });
    const allBody = (await all.json()) as { entries: Array<{ action: string }>; hasMore: boolean };
    expect(allBody.hasMore).toBe(false);
    expect(allBody.entries.map((entry) => entry.action)).toContain("token.issue");
  });

  it("round-trips notification rules and defaults them", async () => {
    const user = freshUser();
    const created = await api("/projects", { user, method: "POST", body: { name: "Rules site" } });
    const { project } = (await created.json()) as { project: { id: string } };

    const initial = await api(`/projects/${project.id}/notification-rules`, { user });
    expect(await initial.json()).toEqual({ rules: { mode: "change", overdueAlways: true } });

    const updated = await api(`/projects/${project.id}/notification-rules`, {
      user,
      method: "PUT",
      body: { mode: "never", overdueAlways: false },
    });
    expect(await updated.json()).toEqual({ rules: { mode: "never", overdueAlways: false } });

    const invalid = await api(`/projects/${project.id}/notification-rules`, { user, method: "PUT", body: { mode: "sometimes" } });
    expect(invalid.status).toBe(400);
  });

  it("reports the workspace with its members and isolates other users", async () => {
    const user = freshUser();
    await api("/projects", { user, method: "POST", body: { name: "Members site" } });

    const ws = await api("/workspace", { user });
    const wsBody = (await ws.json()) as { workspace: { name: string }; members: Array<{ userId: string }> };
    expect(wsBody.members.map((member) => member.userId)).toEqual([user]);

    const stranger = freshUser();
    const strangerActivity = await api("/activity", { user: stranger });
    const strangerBody = (await strangerActivity.json()) as { entries: unknown[]; hasMore: boolean };
    expect(strangerBody.entries).toHaveLength(0);
    expect(strangerBody.hasMore).toBe(false);
  });
});
