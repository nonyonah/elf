import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/index.js";

const app = createApp();
const bindings = {...env, SLACK_CLIENT_ID: "slack-id", SLACK_CLIENT_SECRET: "slack-server-secret", FIGMA_CLIENT_ID: "figma-id", FIGMA_CLIENT_SECRET: "figma-server-secret"};
const origin = "https://console.test";
const verifier = "a".repeat(43);
const localState = "b".repeat(64);
async function challenge() {const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))); return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");}
async function request(path: string, init?: RequestInit) {return app.request(origin + "/api/local-connect" + path, init, bindings);}
async function start(provider = "slack", returnUri = `http://127.0.0.1:3456/api/${provider}/broker-callback`) {
  const response = await request(`/${provider}/start?${new URLSearchParams({state: localState, challenge: await challenge(), return_uri: returnUri})}`);
  return {response, id: new URL(response.headers.get("Location") ?? origin).searchParams.get("state")!, cookie: response.headers.get("Set-Cookie")?.split(";")[0] ?? ""};
}
async function complete(provider = "slack") {
  const flow = await start(provider);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    // Exercise workerd's Request validation before returning a provider fixture.
    // A fetch stub alone otherwise hides unsupported runtime request options.
    new Request(url, init);
    if (provider === "slack") {
      expect(url).toBe("https://slack.com/api/oauth.v2.access");
      expect(String(init.body)).toContain("client_secret=slack-server-secret");
      return Response.json({ok: true, team: {id: "T1", name: "Test"}, incoming_webhook: {url: "https://hooks.slack.com/services/T1/B1/testsecret", channel: "#design", channel_id: "C1"}});
    }
    expect(url).toBe("https://api.figma.com/v1/oauth/token");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("figma-id:figma-server-secret")}`);
    return Response.json({access_token: "private-figma-access", refresh_token: "private-figma-refresh", expires_in: 3600});
  });
  const response = await request(`/${provider}/callback?code=test-code&state=${flow.id}`, {headers: {Cookie: flow.cookie}});
  const redirect = new URL(response.headers.get("Location")!);
  return {...flow, redirect, grant: redirect.searchParams.get("grant")!};
}
async function exchange(grant: string, proof = verifier, provider = "slack", headers: Record<string, string> = {}) {
  return request(`/${provider}/exchange`, {method: "POST", headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify({grant, verifier: proof})});
}
beforeEach(async () => {await env.DB.prepare("DELETE FROM local_oauth").run(); await env.DB.prepare("DELETE FROM rate_limits WHERE scope LIKE 'local-oauth:%'").run();});
afterEach(() => vi.unstubAllGlobals());

describe("local OAuth delivery", () => {
  it("refreshes Figma credentials with a workerd-compatible request", async () => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      new Request(url, init);
      expect(url).toBe("https://api.figma.com/v1/oauth/refresh");
      expect(init.redirect).toBe("manual");
      expect(new Headers(init.headers).get("Authorization")).toBe(`Basic ${btoa("figma-id:figma-server-secret")}`);
      return Response.json({access_token: "refreshed-private-token", expires_in: 3600});
    });
    const response = await request("/figma/refresh", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({refreshToken: "private-refresh-token"})});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({accessToken: "refreshed-private-token"});
  });
  it("rejects provider redirects without following or delivering a grant", async () => {
    for (const provider of ["slack", "figma"]) {
      const flow = await start(provider);
      let calls = 0;
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        new Request(url, init);
        expect(init.redirect).toBe("manual");
        calls++;
        return new Response(null, {status: 302, headers: {Location: "https://untrusted.test/"}});
      });
      const response = await request(`/${provider}/callback?code=test&state=${flow.id}`, {headers: {Cookie: flow.cookie}});
      const target = new URL(response.headers.get("Location")!);
      expect(target.searchParams.has("grant")).toBe(false);
      expect(target.searchParams.get("error")).toBe("connection_failed");
      expect(calls).toBe(1);
    }
  });
  it("returns fixed Figma failure reasons without leaking provider response text", async () => {
    for (const [error, expected] of [["invalid_client", "invalid_client"], ["private-token-secret", "provider_rejected"]]) {
      const flow = await start("figma");
      vi.stubGlobal("fetch", async () => Response.json({error, message: "private-provider-response"}, {status: 400}));
      const response = await request(`/figma/callback?code=test&state=${flow.id}`, {headers: {Cookie: flow.cookie}});
      const target = new URL(response.headers.get("Location")!);
      expect(target.searchParams.get("reason")).toBe(expected);
      expect(target.href).not.toContain("private-");
      expect(target.searchParams.has("grant")).toBe(false);
      expect(await env.DB.prepare("SELECT id FROM local_oauth WHERE id = ?").bind(flow.id).first()).toBeNull();
    }
  });
  it("exchanges once, seals credentials at rest, and never redirects credentials through the browser", async () => {
    const flow = await complete();
    expect(flow.redirect.origin).toBe("http://127.0.0.1:3456");
    expect(flow.redirect.searchParams.get("state")).toBe(localState);
    expect(flow.redirect.href).not.toContain("testsecret");
    const row = await env.DB.prepare("SELECT * FROM local_oauth WHERE id = ?").bind(flow.id).first();
    expect(JSON.stringify(row)).not.toContain("testsecret");
    expect(JSON.stringify(row)).not.toContain(flow.grant);
    expect((await exchange(flow.grant, "x".repeat(43))).status).toBe(400);
    const responses = await Promise.all([exchange(flow.grant), exchange(flow.grant)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
    expect(await responses.find(response => response.status === 200)!.json()).toMatchObject({channel: "#design"});
    expect((await exchange(flow.grant)).status).toBe(400);
  });
  it("requires the same browser, rejects replay and disallows remote return addresses", async () => {
    expect((await start("slack", "https://attacker.test/callback")).response.status).toBe(400);
    expect((await start("slack", "http://127.0.0.1:3456/not-the-callback")).response.status).toBe(400);
    const flow = await start();
    expect((await request(`/slack/callback?code=test&state=${flow.id}`)).status).toBe(400);
    expect((await request(`/figma/callback?code=test&state=${flow.id}`, {headers: {Cookie: flow.cookie}})).status).toBe(400);
  });
  it("binds Figma credentials to the provider and rejects cross-origin redemption", async () => {
    const flow = await complete("figma");
    expect((await exchange(flow.grant, verifier, "slack")).status).toBe(400);
    expect((await exchange(flow.grant, verifier, "figma", {Origin: "https://attacker.test"})).status).toBe(403);
    const response = await exchange(flow.grant, verifier, "figma");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toMatchObject({accessToken: "private-figma-access"});
  });
  it("expires grants and callbacks, and validates error callbacks before returning locally", async () => {
    const flow = await complete();
    await env.DB.prepare("UPDATE local_oauth SET expiresAt = 0 WHERE id = ?").bind(flow.id).run();
    expect((await exchange(flow.grant)).status).toBe(400);
    expect((await request(`/slack/callback?code=test&state=${flow.id}`, {headers: {Cookie: flow.cookie}})).status).toBe(400);
    const declined = await start();
    const error = await request(`/slack/callback?error=access_denied&state=${declined.id}`, {headers: {Cookie: declined.cookie}});
    expect(new URL(error.headers.get("Location")!).searchParams.get("error")).toBe("connection_failed");
    expect((await request(`/slack/callback?code=replay&state=${declined.id}`, {headers: {Cookie: declined.cookie}})).status).toBe(400);
  });
});
