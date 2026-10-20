import { Hono } from "hono";
import { apiV1 } from "./api.js";
import { getSession, requireSession, workspaceNameFor, type AppEnv, type SessionResolver } from "./auth.js";
import { dashboard } from "./dashboard.js";
import { ensureWorkspace } from "./db/workspaces.js";
import type { Env } from "./env.js";
import { runDueJobs } from "./jobs.js";
import { POLL_CRON, pollFigmaSources } from "./poll.js";

/**
 * elf-console Worker. Serves the API under /api/* (routed here first via
 * `run_worker_first`) and the Vite build as static assets for everything else.
 * `createApp` takes an injectable session resolver so tests can run whole
 * request flows with fake identities.
 */
export function createApp(options: { sessionResolver?: SessionResolver } = {}) {
  const app = new Hono<AppEnv>();

  // Public surface. Registered before the session middleware, so it stays open.
  app.get("/api/health", (c) => c.json({ ok: true, service: "elf-console", version: "0.1.0" }));

  // The client contract (token-scoped, its own auth model) — mounted before
  // the Clerk gate, which then only sees the dashboard-UI routes.
  app.route("/api/v1", apiV1());

  app.use("/api/*", requireSession(options.sessionResolver));

  // Dashboard API (workspace-scoped) — registered after the gate, so every
  // route below is Clerk-protected.
  app.route("/api", dashboard());

  app.get("/api/me", async (c) => {
    const session = getSession(c);
    const workspace = await ensureWorkspace(
      c.env.DB,
      session.userId,
      await workspaceNameFor(c.env, session.userId),
    );
    return c.json({ userId: session.userId, workspace });
  });

  app.all("/api/*", (c) =>
    c.json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404),
  );

  return app;
}

const app = createApp();

export default {
  fetch: app.fetch,
  /**
   * Minute cron sweeps the jobs table (drift jobs are usually kicked earlier
   * by ingest); the 15-minute cron first polls Figma file versions so the UI
   * can ask for a fresh snapshot when the file moved on.
   */
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    if (controller.cron === POLL_CRON) await pollFigmaSources(env);
    await runDueJobs(env);
  },
} satisfies ExportedHandler<Env>;
