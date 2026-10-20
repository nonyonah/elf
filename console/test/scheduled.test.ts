import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import wranglerConfig from "../wrangler.jsonc?raw";
import worker from "../src/index.js";
import { POLL_CRON } from "../src/poll.js";

async function dispatch(cron: string): Promise<void> {
  const controller = createScheduledController({ scheduledTime: Date.now(), cron });
  await worker.scheduled!(controller, env);
}

describe("scheduled handler", () => {
  it("declares every cron the handler branches on in wrangler.jsonc", () => {
    expect(wranglerConfig).toContain(`"${POLL_CRON}"`);
    expect(wranglerConfig).toContain('"* * * * *"');
  });

  it("runs the minute sweep against an idle database", async () => {
    await dispatch("* * * * *");
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });

  it("runs the poll cron with no connections and leaves no work behind", async () => {
    await dispatch(POLL_CRON);
    const connections = await env.DB.prepare("SELECT COUNT(*) AS n FROM connections").first<{ n: number }>();
    expect(connections?.n).toBe(0);
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });

  it("treats an unknown cron as a plain job sweep", async () => {
    await dispatch("0 0 * * *");
    const jobs = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs?.n).toBe(0);
  });
});
