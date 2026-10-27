import { Hono } from "hono";
import type { AppEnv } from "./auth.js";
import { importSecretsKey, openSecret, sealSecret } from "./db/crypto.js";
import { takeRateLimit } from "./ratelimit.js";

const TTL = 10 * 60_000;
const opaque = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
const encoder = new TextEncoder();
// Only fixed diagnostic codes cross the browser redirect. Never forward provider
// response bodies, exception messages, authorization codes, or credentials.
class ConnectionFailure extends Error {
  constructor(readonly reason: string) { super(reason); }
}
// workerd rejects redirect:"error" before sending a request. Use "manual"
// and reject every non-2xx response so credentials never follow redirects.
function providerFailure(value: unknown): string {
  return typeof value === "string" && ["access_denied", "invalid_client", "invalid_grant", "invalid_scope", "redirect_uri_mismatch", "unauthorized_client"].includes(value) ? value : "provider_rejected";
}
async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function challenge(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
interface Pending { id: string; provider: string; challenge: string; browserHash: string; localState: string; returnUri: string; expiresAt: number; status: string; ciphertext: string; iv: string; }
function callback(origin: string, provider: string): string { return `${origin}/api/local-connect/${provider}/callback`; }
function returnUri(raw: string, provider: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || Number(url.port) < 1024 || url.pathname !== `/api/${provider}/broker-callback` || url.username || url.password || url.search || url.hash) return null;
    return url.href;
  } catch { return null; }
}
/** Bound all external responses and request bodies before JSON parsing. */
async function jsonBody<T>(response: Request | Response): Promise<T> {
  if (!response.body) throw new Error("Missing JSON body");
  const reader = response.body.getReader(); let size = 0; let text = ""; const decoder = new TextDecoder();
  try {
    while (true) { const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 16_384) throw new Error("JSON body too large"); text += decoder.decode(value, {stream: true}); }
    return JSON.parse(text + decoder.decode()) as T;
  } finally { await reader.cancel().catch(() => {}); }
}

/** Independent of dashboard sign-in; each grant belongs only to its local verifier. */
export function localOAuth() {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff"); c.header("X-Frame-Options", "DENY");
    const figma = c.req.path.includes("/figma/");
    if (!(figma ? c.env.FIGMA_CLIENT_ID && c.env.FIGMA_CLIENT_SECRET : c.env.SLACK_CLIENT_ID && c.env.SLACK_CLIENT_SECRET) || !c.env.SECRETS_KEY || !c.env.CONSOLE_ORIGIN?.startsWith("https://")) return c.json({error: "Connection service is not configured yet."}, 503);
    if (new URL(c.req.url).origin !== new URL(c.env.CONSOLE_ORIGIN).origin) return c.json({error: "Use the configured connection service origin."}, 400);
    const limit = await takeRateLimit(c.env.DB, `local-oauth:${c.req.header("CF-Connecting-IP") ?? "unknown"}`, 30);
    if (!limit.allowed) {c.header("Retry-After", String(limit.retryAfterSeconds)); return c.json({error: "Too many connection requests. Try again shortly."}, 429);}
    await next();
  });
  app.get("/:provider/start", async c => {
    const provider = c.req.param("provider"); if (provider !== "slack" && provider !== "figma") return c.json({error: "Unknown provider."}, 404);
    const uri = returnUri(c.req.query("return_uri") ?? "", provider); const state = c.req.query("state") ?? ""; const proof = c.req.query("challenge") ?? "";
    if (!uri || !/^[a-f0-9]{64}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return c.json({error: "Invalid local connection request."}, 400);
    const globalLimit = await takeRateLimit(c.env.DB, "local-oauth:global-start", 1000);
    if (!globalLimit.allowed) return c.json({error: "Connection service is busy. Try again shortly."}, 429);
    const id = opaque(); const browser = opaque(); const now = Date.now();
    await c.env.DB.prepare("DELETE FROM local_oauth WHERE expiresAt < ?").bind(now).run();
    await c.env.DB.prepare("INSERT INTO local_oauth (id, provider, challenge, browserHash, localState, returnUri, expiresAt, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')").bind(id, provider, proof, await hash(browser), state, uri, now + TTL).run();
    c.header("Set-Cookie", `__Host-elf-local-${id}=${browser}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const url = new URL(provider === "slack" ? "https://slack.com/oauth/v2/authorize" : "https://www.figma.com/oauth");
    url.search = new URLSearchParams({client_id: (provider === "slack" ? c.env.SLACK_CLIENT_ID : c.env.FIGMA_CLIENT_ID)!, scope: provider === "slack" ? "incoming-webhook" : "file_content:read", redirect_uri: callback(c.env.CONSOLE_ORIGIN!, provider), state: id, ...(provider === "figma" ? {response_type: "code"} : {})}).toString();
    return c.redirect(url.href, 302);
  });
  app.get("/:provider/callback", async c => {
    const provider = c.req.param("provider"); if (provider !== "slack" && provider !== "figma") return c.json({error: "Unknown provider."}, 404);
    const id = c.req.query("state") ?? ""; const code = c.req.query("code");
    if (!/^[a-f0-9]{64}$/.test(id)) return c.text("Invalid or expired connection. Return to Elf Settings and try again.", 400);
    const browser = (c.req.header("Cookie") ?? "").split(/;\s*/).find(part => part.startsWith(`__Host-elf-local-${id}=`))?.split("=")[1] ?? "";
    if (!/^[a-f0-9]{64}$/.test(browser)) return c.text("This connection must finish in the browser where it started.", 400);
    const pending = await c.env.DB.prepare("UPDATE local_oauth SET status = 'exchanging' WHERE id = ? AND provider = ? AND status = 'pending' AND browserHash = ? AND expiresAt > ? RETURNING *").bind(id, provider, await hash(browser), Date.now()).first<Pending>();
    if (!pending) return c.text("Invalid, expired, or already used connection. Return to Elf Settings.", 400);
    c.header("Set-Cookie", `__Host-elf-local-${id}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    const destination = new URL(pending.returnUri); destination.searchParams.set("state", pending.localState);
    try {
      if (c.req.query("error")) throw new ConnectionFailure(providerFailure(c.req.query("error")));
      if (!code || code.length > 2048) throw new ConnectionFailure("missing_code");
      let result: Record<string, unknown>;
      if (provider === "slack") {
      const response = await fetch("https://slack.com/api/oauth.v2.access", {method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: {"Content-Type": "application/x-www-form-urlencoded"}, body: new URLSearchParams({client_id: c.env.SLACK_CLIENT_ID!, client_secret: c.env.SLACK_CLIENT_SECRET!, code, redirect_uri: callback(c.env.CONSOLE_ORIGIN!, provider)})});
      if (!response.ok) throw new Error("Slack exchange failed");
      const token = await jsonBody<{ok?: boolean; incoming_webhook?: {url?: string; channel?: string; channel_id?: string}; team?: {id?: string; name?: string}}>(response);
      const hook = token.incoming_webhook;
      if (!token.ok || typeof hook?.url !== "string" || !/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/.test(hook.url) || typeof hook.channel !== "string" || typeof hook.channel_id !== "string") throw new Error("Missing valid webhook");
        result = {url: hook.url, channel: hook.channel, channelId: hook.channel_id, teamName: token.team?.name ?? "Slack", teamId: token.team?.id ?? "unknown", configuredAt: new Date().toISOString()};
      } else {
        result = await figmaExchange(c.env, new URLSearchParams({code, redirect_uri: callback(c.env.CONSOLE_ORIGIN!, provider), grant_type: "authorization_code"}));
      }
      let sealed;
      try {sealed = await sealSecret(JSON.stringify({id, provider, result}), await importSecretsKey(c.env.SECRETS_KEY!));}
      catch {throw new ConnectionFailure("credential_storage");}
      const grant = opaque();
      await c.env.DB.prepare("UPDATE local_oauth SET status = 'ready', grantHash = ?, ciphertext = ?, iv = ? WHERE id = ? AND status = 'exchanging'").bind(await hash(grant), sealed.ciphertext, sealed.iv, id).run();
      destination.searchParams.set("grant", grant);
    } catch (error) {
      await c.env.DB.prepare("DELETE FROM local_oauth WHERE id = ?").bind(id).run(); destination.searchParams.set("error", "connection_failed");
      destination.searchParams.set("reason", error instanceof ConnectionFailure ? error.reason : "service_error");
    }
    return c.redirect(destination.href, 302);
  });
  app.post("/:provider/exchange", async c => {
    const provider = c.req.param("provider"); if (provider !== "slack" && provider !== "figma") return c.json({error: "Unknown provider."}, 404);
    // Browser origins have no access to credential delivery, even if they know a grant.
    if (c.req.header("Origin") || !c.req.header("Content-Type")?.startsWith("application/json")) return c.json({error: "Local client exchange required."}, 403);
    let body: {grant?: string; verifier?: string};
    try {body = await jsonBody(c.req.raw);} catch {return c.json({error: "Invalid exchange."}, 400);}
    if (typeof body.grant !== "string" || !/^[a-f0-9]{64}$/.test(body.grant) || typeof body.verifier !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(body.verifier)) return c.json({error: "Invalid exchange."}, 400);
    const pending = await c.env.DB.prepare("DELETE FROM local_oauth WHERE grantHash = ? AND provider = ? AND challenge = ? AND status = 'ready' AND expiresAt > ? RETURNING *").bind(await hash(body.grant), provider, await challenge(body.verifier), Date.now()).first<Pending>();
    if (!pending) return c.json({error: "Invalid, expired, or already used grant."}, 400);
    const payload = JSON.parse(await openSecret(pending, await importSecretsKey(c.env.SECRETS_KEY!))) as {id: string; provider: string; result: unknown};
    if (payload.id !== pending.id || payload.provider !== provider) return c.json({error: "Invalid grant."}, 400);
    return c.json(payload.result as Record<string, unknown>);
  });
  app.post("/figma/refresh", async c => {
    if (c.req.header("Origin") || !c.req.header("Content-Type")?.startsWith("application/json")) return c.json({error: "Local client required."}, 403);
    try {
      const body = await jsonBody<{refreshToken?: string}>(c.req.raw);
      if (typeof body.refreshToken !== "string" || body.refreshToken.length < 16 || body.refreshToken.length > 2048) return c.json({error: "Invalid refresh request."}, 400);
      return c.json(await figmaExchange(c.env, new URLSearchParams({refresh_token: body.refreshToken}), true));
    } catch {return c.json({error: "Reconnect your Figma account in Elf Settings."}, 400);}
  });
  return app;
}

async function figmaExchange(env: AppEnv["Bindings"], body: URLSearchParams, refresh = false): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.figma.com/v1/oauth/${refresh ? "refresh" : "token"}`, {method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: {"Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${btoa(`${env.FIGMA_CLIENT_ID}:${env.FIGMA_CLIENT_SECRET}`)}`}, body});
  if (!response.ok) {
    let reason = response.status === 401 ? "invalid_client" : "provider_rejected";
    try {const body = await jsonBody<{error?: unknown}>(response); if (typeof body.error === "string") reason = providerFailure(body.error);} catch { /* Discard untrusted or oversized provider errors. */ }
    throw new ConnectionFailure(reason);
  }
  const token = await jsonBody<{access_token?: string; refresh_token?: string; expires_in?: number}>(response);
  if (typeof token.access_token !== "string" || !token.access_token || typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0 || (!refresh && typeof token.refresh_token !== "string")) throw new Error("Invalid Figma credentials");
  return {accessToken: token.access_token, ...(token.refresh_token ? {refreshToken: token.refresh_token} : {}), expiresAt: Date.now() + token.expires_in * 1000};
}
