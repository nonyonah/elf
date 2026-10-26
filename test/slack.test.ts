import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  readSlackWebhook,
  writeSlackWebhook,
  removeSlackWebhook,
  maskWebhookUrl,
  getSlackClientId,
  startCallbackServer,
  waitForCallback,
  connectSlackManual,
  disconnectSlack,
} from "../src/slack.js";

const SLACK_WEBHOOK_URL = [
  "https://hooks.slack.com",
  "services",
  "T00000000",
  "B00000000",
  "XXXXXXXXXXXXXXXXXXXXXXXX",
].join("/");

const originalEnv = { ...process.env };

function stubFetch(handler: (url: string, init?: RequestInit) => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("generateCodeVerifier returns a URL-safe string of correct length", () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  // 32 bytes base64url = 43 chars (no padding)
  assert.equal(v.length, 43);
});

test("generateCodeVerifier is unique per call", () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b);
});

test("generateCodeChallenge produces correct S256 challenge", () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"; // RFC 7636 test vector
  const challenge = generateCodeChallenge(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("buildAuthorizeUrl includes all required PKCE parameters", () => {
  const url = buildAuthorizeUrl("client123", "http://127.0.0.1:1234/callback", "challenge123", "state123");
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, "https://slack.com/oauth/v2/authorize");
  assert.equal(parsed.searchParams.get("client_id"), "client123");
  assert.equal(parsed.searchParams.get("scope"), "incoming-webhook");
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://127.0.0.1:1234/callback");
  assert.equal(parsed.searchParams.get("code_challenge"), "challenge123");
  assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
  assert.equal(parsed.searchParams.get("state"), "state123");
});

test("buildAuthorizeUrl omits PKCE parameters for a client-secret app", () => {
  const url = buildAuthorizeUrl("client123", "http://localhost:1234/callback", null, "state123");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("redirect_uri"), "http://localhost:1234/callback");
  assert.equal(parsed.searchParams.get("code_challenge"), null);
  assert.equal(parsed.searchParams.get("code_challenge_method"), null);
});

test("exchangeCodeForToken sends correct form data without client_secret", async () => {
  let capturedBody: string | null = null;
  const restore = stubFetch((url, init) => {
    capturedBody = init?.body as string;
    return json({ ok: true, incoming_webhook: { url: SLACK_WEBHOOK_URL, channel: "general", channel_id: "C12345" }, team: { id: "T12345", name: "Test Team" } });
  });
  try {
    await exchangeCodeForToken("client123", "authcode123", "http://127.0.0.1:1234/callback", "verifier123");
    assert.ok(capturedBody);
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("client_id"), "client123");
    assert.equal(params.get("code"), "authcode123");
    assert.equal(params.get("redirect_uri"), "http://127.0.0.1:1234/callback");
    assert.equal(params.get("code_verifier"), "verifier123");
    assert.equal(params.get("client_secret"), null, "client_secret must not be sent for PKCE");
  } finally {
    restore();
  }
});

test("exchangeCodeForToken sends a client secret for a non-PKCE app", async () => {
  let capturedBody: string | null = null;
  const restore = stubFetch((url, init) => {
    capturedBody = init?.body as string;
    return json({ ok: true, incoming_webhook: { url: SLACK_WEBHOOK_URL, channel: "general", channel_id: "C12345" }, team: { id: "T12345", name: "Test Team" } });
  });
  try {
    await exchangeCodeForToken(
      "client123",
      "authcode123",
      "http://localhost:1234/callback",
      null,
      undefined,
      "secret123",
    );
    assert.ok(capturedBody);
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("client_secret"), "secret123");
    assert.equal(params.get("code_verifier"), null);
  } finally {
    restore();
  }
});

test("exchangeCodeForToken returns error response from Slack (caller handles throwing)", async () => {
  const restore = stubFetch(() => json({ ok: false, error: "invalid_code", error_description: "Code expired" }));
  try {
    const result = await exchangeCodeForToken("client123", "badcode", "http://127.0.0.1:1234/callback", "verifier123");
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_code");
    assert.equal(result.error_description, "Code expired");
  } finally {
    restore();
  }
});

test("readSlackWebhook returns null for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  assert.equal(readSlackWebhook(configPath), null);
  rmSync(dir, { recursive: true });
});

test("readSlackWebhook returns null for invalid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  mkdirSync(join(dir, ".elf"), { recursive: true });
  writeFileSync(join(dir, ".elf", "slack-webhook.json"), "not json");
  assert.equal(readSlackWebhook(configPath), null);
  rmSync(dir, { recursive: true });
});

test("readSlackWebhook returns null for missing required fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  mkdirSync(join(dir, ".elf"), { recursive: true });
  writeFileSync(join(dir, ".elf", "slack-webhook.json"), JSON.stringify({ url: "https://hooks.slack.com/..." }));
  assert.equal(readSlackWebhook(configPath), null);
  rmSync(dir, { recursive: true });
});

test("writeSlackWebhook and readSlackWebhook round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  mkdirSync(join(dir, ".elf"), { recursive: true });

  const info = {
    url: SLACK_WEBHOOK_URL,
    channel: "general",
    channelId: "C12345",
    teamName: "Test Team",
    teamId: "T12345",
    configuredAt: "2026-10-23T12:00:00.000Z",
  };
  writeSlackWebhook(configPath, info);
  const read = readSlackWebhook(configPath);
  assert.deepEqual(read, info);
  rmSync(dir, { recursive: true });
});

test("removeSlackWebhook deletes the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  mkdirSync(join(dir, ".elf"), { recursive: true });
  writeFileSync(join(dir, ".elf", "slack-webhook.json"), JSON.stringify({ url: "x", channel: "y", channelId: "z", teamName: "t", teamId: "i", configuredAt: "now" }));
  assert.ok(readFileSync(join(dir, ".elf", "slack-webhook.json"), "utf8"));
  assert.equal(removeSlackWebhook(configPath), true);
  try { readFileSync(join(dir, ".elf", "slack-webhook.json"), "utf8"); assert.fail("file should be gone"); } catch {}
  rmSync(dir, { recursive: true });
});

test("removeSlackWebhook returns false when file doesn't exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  assert.equal(removeSlackWebhook(configPath), false);
  rmSync(dir, { recursive: true });
});

test("maskWebhookUrl masks the URL showing only last 12 chars", () => {
  const url = SLACK_WEBHOOK_URL;
  const masked = maskWebhookUrl(url);
  assert.ok(masked.startsWith("••••••••••••"));
  assert.ok(masked.endsWith("XXXXXXXXXXXX"));
  // Masked URL: 12 bullets + last 12 chars = 24 chars
  assert.equal(masked.length, 24);
});

test("maskWebhookUrl handles short URLs", () => {
  const url = "short";
  const masked = maskWebhookUrl(url);
  // Short URLs (<= 16 chars) return 12 bullets
  assert.equal(masked, "••••••••••••");
});

test("getSlackClientId returns default when env not set", () => {
  delete process.env.ELF_SLACK_CLIENT_ID;
  assert.equal(getSlackClientId(), "10923381069686.12320909036695");
});

test("getSlackClientId returns env override when set", () => {
  process.env.ELF_SLACK_CLIENT_ID = "custom_client_id";
  assert.equal(getSlackClientId(), "custom_client_id");
  delete process.env.ELF_SLACK_CLIENT_ID;
});

test("startCallbackServer listens on 127.0.0.1 and closes", async () => {
  const { server, port } = await startCallbackServer();
  const address = server.address();
  assert.ok(address && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");
  assert.ok(port > 0);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("waitForCallback resolves with the code and state", async () => {
  const { server, port } = await startCallbackServer();
  const result = waitForCallback(server, "expected-state", 2000);
  const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=expected-state`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Connected to Slack/);
  assert.deepEqual(await result, { code: "auth-code", state: "expected-state" });
});

test("waitForCallback rejects on a state mismatch and responds 400", async () => {
  const { server, port } = await startCallbackServer();
  const result = waitForCallback(server, "expected-state", 2000);
  const rejected = assert.rejects(result, /Invalid OAuth state/);
  const response = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=wrong-state`);
  assert.equal(response.status, 400);
  await rejected;
});

test("waitForCallback rejects on a Slack error and responds 400", async () => {
  const { server, port } = await startCallbackServer();
  const result = waitForCallback(server, "expected-state", 2000);
  const rejected = assert.rejects(result, /Slack OAuth error: access_denied/);
  const response = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);
  assert.equal(response.status, 400);
  assert.match(await response.text(), /access_denied/);
  await rejected;
});

test("waitForCallback times out and closes the server", async () => {
  const { server } = await startCallbackServer();
  const closed = new Promise<void>((resolve) => server.once("close", () => resolve()));
  await assert.rejects(waitForCallback(server, "expected-state", 50), /timed out/);
  await closed;
  assert.equal(server.listening, false);
});

test("connectSlackManual rejects non-Slack webhook URLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  await assert.rejects(
    connectSlackManual(configPath, "https://example.com/webhook"),
    /Invalid Slack webhook URL/,
  );
  rmSync(dir, { recursive: true });
});

test("connectSlackManual stores a manual webhook and disconnectSlack removes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-slack-test-"));
  const configPath = join(dir, "elf.config.json");
  const url = SLACK_WEBHOOK_URL;
  const info = await connectSlackManual(configPath, url);
  assert.equal(info.url, url);
  assert.equal(info.channel, "manual");
  assert.equal(info.teamName, "Manual Entry");
  assert.deepEqual(readSlackWebhook(configPath), info);

  assert.equal(await disconnectSlack(configPath), true);
  assert.equal(readSlackWebhook(configPath), null);
  rmSync(dir, { recursive: true });
});

// Restore env after all tests
test("env restored", () => {
  process.env = originalEnv;
});