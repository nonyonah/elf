import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SessionResolver } from "../src/auth.js";
import { createApp } from "../src/index.js";

const signedInAs = (userId: string): SessionResolver => async () => ({ userId });

describe("session middleware", () => {
  it("returns the contract's 401 body when there is no session", async () => {
    const app = createApp({ sessionResolver: async () => null });
    const response = await app.request("/api/me", undefined, env);
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBeTruthy();
  });

  it("lets /api/health through before the session gate", async () => {
    const app = createApp({ sessionResolver: async () => null });
    const response = await app.request("/api/health", undefined, env);
    expect(response.status).toBe(200);
  });
});

describe("/api/me", () => {
  it("provisions exactly one workspace on first request and reuses it after", async () => {
    const userId = `user_${crypto.randomUUID()}`;
    const app = createApp({ sessionResolver: signedInAs(userId) });

    const first = await app.request("/api/me", undefined, env);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { userId: string; workspace: { id: string; name: string } };
    expect(firstBody.userId).toBe(userId);
    expect(firstBody.workspace.id).toBeTruthy();

    const second = await app.request("/api/me", undefined, env);
    const secondBody = (await second.json()) as { workspace: { id: string } };
    expect(secondBody.workspace.id).toBe(firstBody.workspace.id);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE userId = ?")
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);

    const membership = await env.DB.prepare("SELECT role FROM members WHERE userId = ?")
      .bind(userId)
      .first<{ role: string }>();
    expect(membership?.role).toBe("owner");
  });

  it("keeps workspaces isolated per Clerk user", async () => {
    const alice = `user_${crypto.randomUUID()}`;
    const bob = `user_${crypto.randomUUID()}`;

    const aliceApp = createApp({ sessionResolver: signedInAs(alice) });
    const bobApp = createApp({ sessionResolver: signedInAs(bob) });

    const aliceBody = (await (await aliceApp.request("/api/me", undefined, env)).json()) as {
      workspace: { id: string };
    };
    const bobBody = (await (await bobApp.request("/api/me", undefined, env)).json()) as {
      workspace: { id: string };
    };

    expect(aliceBody.workspace.id).not.toBe(bobBody.workspace.id);

    const memberships = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM members WHERE userId IN (?, ?)",
    )
      .bind(alice, bob)
      .first<{ n: number }>();
    expect(memberships?.n).toBe(2);

    const shared = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM members WHERE userId = ? AND workspaceId = ?",
    )
      .bind(alice, bobBody.workspace.id)
      .first<{ n: number }>();
    expect(shared?.n).toBe(0);
  });

  it("404s authenticated requests to unknown endpoints with the contract error shape", async () => {
    const app = createApp({ sessionResolver: signedInAs(`user_${crypto.randomUUID()}`) });
    const response = await app.request("/api/definitely-not-here", undefined, env);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
