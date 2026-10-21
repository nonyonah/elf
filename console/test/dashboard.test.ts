import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createToken } from "../src/db/tokens.js";
import { createApp } from "../src/index.js";
import { runDueJobs } from "../src/jobs.js";

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

interface ProjectShape {
  id: string;
  slug: string;
  name: string;
}

async function createProjectFor(user: string, name = "Site tokens"): Promise<ProjectShape> {
  const response = await api("/projects", { user, method: "POST", body: { name } });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { project: ProjectShape };
  return body.project;
}

function codePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
  };
}

async function ingest(projectId: string, payload: Record<string, unknown>): Promise<void> {
  const token = await createToken(env.DB, projectId, "push");
  const response = await app.request(
    "/api/v1/ingest/code",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    env,
  );
  expect(response.status).toBe(202);
}

interface DashboardListBody {
  projects: Array<{
    id: string;
    state: string;
    counts: Record<string, number>;
    tokenCounts: { figma: number; code: number } | null;
    componentCount: number | null;
    fileKey: string | null;
  }>;
  summary: { total: number; ok: number; drift: number; stale: number; unknown: number };
  trend: Array<{ date: string; total: number }>;
}

describe("dashboard API", () => {
  it("requires a session for every /api route and 404s unknown ones after auth", async () => {
    const signedOut = await api("/projects");
    expect(signedOut.status).toBe(401);
    expect(((await signedOut.json()) as { error: { code: string } }).error.code).toBe("unauthorized");

    const unknown = await api("/definitely-not-a-route", { user: freshUser() });
    expect(unknown.status).toBe(404);
  });

  it("creates projects with unique slugs and lists them with a zeroed summary", async () => {
    const user = freshUser();
    const first = await createProjectFor(user, "Design tokens");
    expect(first.slug).toBe("design-tokens");
    const second = await createProjectFor(user, "Design tokens");
    expect(second.slug).toBe("design-tokens-2");

    const list = await api("/projects", { user });
    expect(list.status).toBe(200);
    const body = (await list.json()) as unknown as DashboardListBody;
    expect(body.projects.map((project) => project.id).sort()).toEqual([first.id, second.id].sort());
    expect(body.summary.total).toBe(2);
    expect(body.summary.unknown).toBe(2);
    expect(body.projects[0]?.counts.valueMismatches).toBe(0);
    expect(body.trend).toHaveLength(30);
    expect(body.trend.every((day) => day.total === 0)).toBe(true);
  });

  it("recomputes drift details live for the project view", async () => {
    const user = freshUser();
    const project = await createProjectFor(user);
    await ingest(
      project.id,
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
    await runDueJobs(env, new Date(Date.now() + 20_000));

    const list = await api("/projects", { user });
    const listed = ((await list.json()) as unknown as DashboardListBody).projects.find(
      (entry) => entry.id === project.id,
    );
    expect(listed?.state).toBe("drift");
    expect(listed?.counts.valueMismatches).toBe(1);
    expect(listed?.tokenCounts).toEqual({ figma: 2, code: 2 });
    expect(listed?.fileKey).toBe("abc123");

    const detail = await api(`/projects/${project.id}`, { user });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      state: string;
      details: {
        valueMismatches: Array<{ name: string; figmaValue: string; codeValue: string }>;
        missingInCode: Array<{ name: string }>;
        missingInFigma: Array<{ name: string }>;
      };
      trend: Array<{ total: number }>;
      latestCode: { gitBranch: string; gitCommit: string } | null;
      latestFigma: unknown;
    };
    expect(body.state).toBe("drift");
    expect(body.details.valueMismatches[0]).toMatchObject({
      name: "accent-500",
      figmaValue: "#6366f1",
      codeValue: "#4f46e5",
    });
    expect(body.details.missingInCode.map((token) => token.name)).toContain("brand");
    expect(body.details.missingInFigma.map((token) => token.name)).toContain("legacy-slate");
    expect(body.trend.length).toBeGreaterThan(0);
    expect(body.trend.at(-1)?.total).toBeGreaterThan(0);
    expect(body.latestCode).toMatchObject({ gitBranch: "main", gitCommit: "8f3c1a9" });

    const unknownProject = await api("/projects/prj_nope", { user });
    expect(unknownProject.status).toBe(404);
  });

  it("handles the deprecations CRUD cycle with validation", async () => {
    const user = freshUser();
    const project = await createProjectFor(user);

    const badType = await api(`/projects/${project.id}/deprecations`, {
      user,
      method: "POST",
      body: { name: "legacy-slate", type: "nope" },
    });
    expect(badType.status).toBe(400);

    const created = await api(`/projects/${project.id}/deprecations`, {
      user,
      method: "POST",
      body: { name: "legacy-slate", type: "token", reason: "sunset", since: "2026-01-01", removeBy: "2026-02-01" },
    });
    expect(created.status).toBe(201);
    const { deprecation } = (await created.json()) as { deprecation: { id: string; name: string; removeBy: string | null } };
    expect(deprecation.name).toBe("legacy-slate");
    expect(deprecation.removeBy).toBe("2026-02-01");

    const duplicate = await api(`/projects/${project.id}/deprecations`, {
      user,
      method: "POST",
      body: { name: "legacy-slate", type: "token" },
    });
    expect(duplicate.status).toBe(400);

    const list = await api(`/projects/${project.id}/deprecations`, { user });
    expect(((await list.json()) as { deprecations: unknown[] }).deprecations).toHaveLength(1);

    const updated = await api(`/projects/${project.id}/deprecations/${deprecation.id}`, {
      user,
      method: "PUT",
      body: { removeBy: null, reason: "extended" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      deprecation: { removeBy: string | null; reason: string | null };
    };
    expect(updatedBody.deprecation.removeBy).toBeNull();
    expect(updatedBody.deprecation.reason).toBe("extended");

    const badDate = await api(`/projects/${project.id}/deprecations/${deprecation.id}`, {
      user,
      method: "PUT",
      body: { since: "tomorrow" },
    });
    expect(badDate.status).toBe(400);

    const deleted = await api(`/projects/${project.id}/deprecations/${deprecation.id}`, { user, method: "DELETE" });
    expect(deleted.status).toBe(200);
    const again = await api(`/projects/${project.id}/deprecations/${deprecation.id}`, { user, method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("stores connection secrets write-only and masks the tail", async () => {
    const user = freshUser();
    const project = await createProjectFor(user);

    const before = await api(`/projects/${project.id}/connections`, { user });
    const beforeBody = (await before.json()) as { connections: unknown[] };
    expect(beforeBody.connections).toEqual([
      expect.objectContaining({ type: "figma", status: "unconfigured", secretTail: null }),
      expect.objectContaining({ type: "slack", status: "unconfigured", secretTail: null }),
    ]);

    const saved = await api(`/projects/${project.id}/connections/slack`, {
      user,
      method: "PUT",
      body: { secret: "https://hooks.slack.com/services/T0/B0/abcd1234" },
    });
    expect(saved.status).toBe(200);
    const savedText = JSON.stringify(await saved.json());
    expect(savedText).toContain("…1234");
    expect(savedText).not.toContain("abcd1234");
    expect(savedText).not.toContain("hooks.slack.com");
    expect(savedText).not.toContain("ciphertext");
    expect(savedText).not.toContain('"iv"');

    const raw = await env.DB.prepare(
      "SELECT encryptedSecret FROM connections WHERE projectId = ? AND type = 'slack'",
    )
      .bind(project.id)
      .first<{ encryptedSecret: string }>();
    expect(raw?.encryptedSecret).toBeTruthy();
    expect(raw?.encryptedSecret).not.toContain("hooks.slack.com");

    const figma = await api(`/projects/${project.id}/connections/figma`, {
      user,
      method: "PUT",
      body: { fileKey: "abc123", fileName: "Site tokens" },
    });
    const figmaBody = (await figma.json()) as { connection: Record<string, unknown> };
    expect(figmaBody.connection).toMatchObject({
      type: "figma",
      status: "bound",
      fileKey: "abc123",
      fileName: "Site tokens",
    });

    const cleared = await api(`/projects/${project.id}/connections/slack`, { user, method: "DELETE" });
    const clearedBody = (await cleared.json()) as { connection: Record<string, unknown> };
    expect(clearedBody.connection).toMatchObject({ type: "slack", status: "unconfigured", secretTail: null });
    const leftover = await env.DB.prepare(
      "SELECT encryptedSecret FROM connections WHERE projectId = ? AND type = 'slack'",
    )
      .bind(project.id)
      .first<{ encryptedSecret: string | null }>();
    expect(leftover?.encryptedSecret).toBeNull();
  });

  it("binds a Figma project from its URL at creation and from settings", async () => {
    const user = freshUser();
    const created = await api("/projects", {
      user,
      method: "POST",
      body: {
        name: "Brand file",
        figmaUrl: "https://www.figma.com/design/AbC123xyz/Brand-file?node-id=1-2",
      },
    });
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: ProjectShape };

    const list = await api(`/projects/${project.id}/connections`, { user });
    const body = (await list.json()) as {
      connections: Array<Record<string, unknown>>;
    };
    expect(body.connections[0]).toMatchObject({
      type: "figma",
      status: "bound",
      fileKey: "AbC123xyz",
      fileName: "Brand file",
      teamName: null,
      channelName: null,
    });

    const updated = await api(`/projects/${project.id}/connections/figma`, {
      user,
      method: "PUT",
      body: { figmaUrl: "https://www.figma.com/file/NextKey99/Second-file" },
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as {
      connection: Record<string, unknown>;
    };
    expect(updatedBody.connection).toMatchObject({
      status: "bound",
      fileKey: "NextKey99",
      fileName: "Second file",
    });

    const invalid = await api(`/projects/${project.id}/connections/figma`, {
      user,
      method: "PUT",
      body: { figmaUrl: "https://example.com/not-a-file" },
    });
    expect(invalid.status).toBe(400);
  });

  it("validates Figma fields when creating a project", async () => {
    const user = freshUser();
    const badUrl = await api("/projects", {
      user,
      method: "POST",
      body: { name: "Nope", figmaUrl: "not a url" },
    });
    expect(badUrl.status).toBe(400);

    const tokenOnly = await api("/projects", {
      user,
      method: "POST",
      body: { name: "Nope", figmaToken: "figd_secret" },
    });
    expect(tokenOnly.status).toBe(400);
    expect(
      ((await tokenOnly.json()) as { error: { code: string } }).error.code,
    ).toBe("invalid_payload");
  });

  it("reports Slack availability and refuses installs until configured", async () => {
    const user = freshUser();
    const project = await createProjectFor(user);

    const workspace = await api("/workspace", { user });
    const workspaceBody = (await workspace.json()) as {
      slackConfigured: boolean;
    };
    expect(workspaceBody.slackConfigured).toBe(false);

    const install = await api(
      `/projects/${project.id}/connections/slack/install`,
      { user },
    );
    expect(install.status).toBe(400);
    expect(
      ((await install.json()) as { error: { code: string } }).error.code,
    ).toBe("slack_not_configured");
  });

  it("keeps workspaces isolated", async () => {
    const alice = freshUser();
    const bob = freshUser();
    const project = await createProjectFor(alice);

    const bobList = await api("/projects", { user: bob });
    expect(((await bobList.json()) as { projects: unknown[] }).projects).toHaveLength(0);

    expect((await api(`/projects/${project.id}`, { user: bob })).status).toBe(404);
    expect((await api(`/projects/${project.id}/deprecations`, { user: bob })).status).toBe(404);
    expect((await api(`/projects/${project.id}/connections`, { user: bob })).status).toBe(404);
  });

  it("records mutations in the audit log", async () => {
    const user = freshUser();
    const project = await createProjectFor(user);
    await api(`/projects/${project.id}/deprecations`, {
      user,
      method: "POST",
      body: { name: "old-btn", type: "component" },
    });

    const rows = await env.DB.prepare(
      `SELECT al.action AS action, al.actor AS actor FROM audit_log al
       JOIN workspaces w ON w.id = al.workspaceId
       JOIN members m ON m.workspaceId = w.id
       WHERE m.userId = ? ORDER BY al.createdAt ASC`,
    )
      .bind(user)
      .all<{ action: string; actor: string }>();
    const actions = rows.results.map((row) => row.action);
    expect(actions).toContain("project.create");
    expect(actions).toContain("deprecation.create");
    expect(rows.results.every((row) => row.actor === user)).toBe(true);
  });
});
