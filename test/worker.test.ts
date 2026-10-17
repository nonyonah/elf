import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker surface", () => {
  it("answers /api/health", async () => {
    const response = await SELF.fetch("https://console.test/api/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "elf-console", version: "0.1.0" });
  });

  it("gates unknown API routes behind auth — signed-out probes get 401, not route info", async () => {
    const response = await SELF.fetch("https://console.test/api/definitely-not-here");
    expect(response.status).toBe(401);
  });

  it("rejects unauthenticated /api requests with a 401", async () => {
    // No CLERK_SECRET_KEY in the test env — the Clerk resolver is "signed out".
    const response = await SELF.fetch("https://console.test/api/me");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("keeps /api/health public even when signed out", async () => {
    const response = await SELF.fetch("https://console.test/api/health");
    expect(response.status).toBe(200);
  });

  it("does not create any workspace rows for signed-out traffic", async () => {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM workspaces").first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});
