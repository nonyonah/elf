import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findConfigPath } from "../src/config.js";
import { loadDotEnvFile } from "../src/env.js";
import { createSettingsServer } from "../src/settings.js";

const SLACK_WEBHOOK_URL = [
  "https://hooks.slack.com",
  "services",
  "T00000000",
  "B00000000",
  "XXXXXXXXXXXXXXXXXXXXXXXX",
].join("/");

interface Workspace {
  dir: string;
  dist: string;
  configPath: string;
}

function createWorkspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "elf-settings-test-"));
  const dist = join(dir, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>Settings</title>");

  const configPath = join(dir, "elf.config.json");
  writeFileSync(configPath, JSON.stringify({
    figma: { fileKey: "test-file" },
    codebase: { path: "." },
    notify: { webhookEnv: "SLACK_WEBHOOK_URL", format: "slack", onlyOnChange: true },
  }, null, 2));

  mkdirSync(join(dir, ".elf"), { recursive: true });
  writeFileSync(join(dir, ".elf", "slack-webhook.json"), JSON.stringify({
    url: SLACK_WEBHOOK_URL,
    channel: "design-system",
    channelId: "C123",
    teamName: "Rift Labs",
    teamId: "T123",
    configuredAt: "2026-10-24T00:00:00.000Z",
  }, null, 2));

  return { dir, dist, configPath };
}

function readConfig(configPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

test("loadDotEnvFile reads keys without overriding the shell", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-env-test-"));
  const envFile = join(dir, ".env");
  writeFileSync(envFile, [
    "# comment",
    "export ELF_SLACK_CLIENT_ID=123.456",
    "ELF_SLACK_CLIENT_SECRET=\"secret-value\"",
    "ALREADY_SET=from-file",
  ].join("\n"));

  const env: NodeJS.ProcessEnv = { ALREADY_SET: "from-shell" };
  try {
    loadDotEnvFile(envFile, env);
    assert.equal(env.ELF_SLACK_CLIENT_ID, "123.456");
    assert.equal(env.ELF_SLACK_CLIENT_SECRET, "secret-value");
    assert.equal(env.ALREADY_SET, "from-shell");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("findConfigPath walks up from a nested folder", () => {
  const { dir, configPath } = createWorkspace();
  const nested = join(dir, "settings-next", "src", "app");
  mkdirSync(nested, { recursive: true });
  try {
    assert.equal(findConfigPath(nested), configPath);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("GET /api/config reports the project, Slack and notify state", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/config`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.project.configPath, configPath);
    assert.equal(body.project.fileKey, "test-file");
    assert.equal(body.slack.connected, true);
    assert.equal(body.slack.teamName, "Rift Labs");
    assert.equal(body.slack.channel, "design-system");
    assert.equal(body.notify.enabled, true);
    assert.equal(body.notify.onlyOnChange, true);
    assert.equal(body.notify.format, "slack");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("PATCH /api/config onlyOnChange writes the field and leaves format alone", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
      body: JSON.stringify({ notify: { onlyOnChange: false } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const config = readConfig(configPath);
    const notify = config.notify as Record<string, unknown>;
    assert.equal(notify.onlyOnChange, false);
    assert.equal(notify.format, "slack", "onlyOnChange must not rewrite the payload format");

    const refreshed = await (await handle.fetch(`${handle.url}/api/config`)).json();
    assert.equal(refreshed.notify.onlyOnChange, false);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("PATCH /api/config enabled false removes the notify section", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
      body: JSON.stringify({ notify: { enabled: false } }),
    });
    assert.equal(response.status, 200);

    const config = readConfig(configPath);
    assert.equal(config.notify, undefined);

    const refreshed = await (await handle.fetch(`${handle.url}/api/config`)).json();
    assert.equal(refreshed.notify, null);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("PATCH /api/config enabled true keeps a custom webhookEnv", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const config = readConfig(configPath);
  (config.notify as Record<string, unknown>).webhookEnv = "CUSTOM_SLACK_WEBHOOK";
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Elf-Request": "1" },
      body: JSON.stringify({ notify: { enabled: true } }),
    });
    assert.equal(response.status, 200);

    const updated = readConfig(configPath);
    assert.equal((updated.notify as Record<string, unknown>).webhookEnv, "CUSTOM_SLACK_WEBHOOK");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("POST /api/slack/disconnect removes the stored webhook", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const before = await (await handle.fetch(`${handle.url}/api/config`)).json();
    assert.equal(before.slack.connected, true);

    const response = await handle.fetch(`${handle.url}/api/slack/disconnect`, { method: "POST", headers: { "X-Elf-Request": "1" } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(existsSync(join(dir, ".elf", "slack-webhook.json")), false);

    const after = await (await handle.fetch(`${handle.url}/api/config`)).json();
    assert.equal(after.slack.connected, false);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("serves the static page and falls back to index.html", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const root = await handle.fetch(`${handle.url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>Settings<\/title>/);

    const fallback = await handle.fetch(`${handle.url}/settings`);
    assert.equal(fallback.status, 200);
    assert.match(await fallback.text(), /<title>Settings<\/title>/);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("POST /api/slack/connect returns a Slack authorize URL", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/slack/connect`, { method: "POST", headers: { "X-Elf-Request": "1" } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.url, /^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
    const authorize = new URL(body.url);
    assert.equal(
      authorize.searchParams.get("redirect_uri"),
      `http://localhost:${handle.port}/callback`,
    );
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("Slack callback rejects a mismatched OAuth state", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(
      `${handle.url}/callback?code=nope&state=wrong`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${handle.url}/?slack=error`);
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});

test("settings rejects foreign origins, rebinding hosts, and unmarked writes", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const original = readFileSync(configPath, "utf8");
    for (const headers of [
      { Origin: "https://untrusted.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const response = await handle.fetch(`${handle.url}/api/config`, { headers });
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    const hostileHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`${handle.url}/api/config`, { headers: { Host: "untrusted.example" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostileHost, 403);
    const write = await handle.fetch(`${handle.url}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notify: { enabled: false } }) });
    assert.equal(write.status, 403);
    assert.equal(readFileSync(configPath, "utf8"), original);
    const preflight = await handle.fetch(`${handle.url}/api/config`, { method: "OPTIONS", headers: { Origin: "https://untrusted.example", "Access-Control-Request-Method": "PATCH" } });
    assert.equal(preflight.status, 403);
  } finally { await handle.close(); rmSync(dir, { recursive: true }); }
});

import { symlinkSync } from "node:fs";
import { saveProjectSetup, projectResource } from "../src/onboarding.js";
import type { BridgeStatus } from "../mcp/src/bridge.js";

const setupBridge: BridgeStatus = { connected: true, port: 8765, address: "127.0.0.1", file: { key: "test-file", name: "Design system" }, plugin: null, connectedAt: null };

test("setup preserves project fields and saves a bridge-based monitoring config", () => {
  const { dir, configPath } = createWorkspace();
  try {
    writeFileSync(join(dir, "tokens.css"), ":root { --primary: #123456; }");
    const before = readConfig(configPath);
    saveProjectSetup(configPath, { tokenPath: "tokens.css", source: "css", autoSync: false }, setupBridge);
    const after = readConfig(configPath) as any;
    assert.deepEqual(after.notify, before.notify);
    assert.equal(after.figma.fileKey, "test-file");
    assert.equal(after.figma.source, "bridge");
    assert.deepEqual(after.codebase, { source: "css", path: "tokens.css" });
    assert.deepEqual(after.runtime, { autoSync: false, projectConfigured: true, setupComplete: false });
  } finally { rmSync(dir, { recursive: true }); }
});

test("setup rejects escapes, symlink escapes, mismatched files and implicit automatic writes", () => {
  const { dir, configPath } = createWorkspace();
  const outside = mkdtempSync(join(tmpdir(), "elf-outside-"));
  try {
    writeFileSync(join(dir, "tokens.css"), ":root {}");
    writeFileSync(join(outside, "outside.css"), "private");
    symlinkSync(join(outside, "outside.css"), join(dir, "linked.css"));
    const original = readFileSync(configPath, "utf8");
    assert.throws(() => projectResource(dir, "linked.css"), /inside this project/);
    assert.throws(() => projectResource(dir, join(outside, "outside.css")), /relative/);
    const input = { tokenPath: "tokens.css", source: "css", autoSync: false };
    assert.throws(() => saveProjectSetup(configPath, input, { ...setupBridge, connected: false }), /Connect/);
    assert.throws(() => saveProjectSetup(configPath, input, { ...setupBridge, file: { key: "draft", name: "Unknown" } }), /real file identity/);
    assert.throws(() => saveProjectSetup(configPath, input, { ...setupBridge, file: { key: "other-file", name: "Other" } }), /does not match/);
    assert.throws(() => saveProjectSetup(configPath, { ...input, autoSync: true }, setupBridge), /reviewing a sync plan/);
    assert.equal(readFileSync(configPath, "utf8"), original);
  } finally { rmSync(dir, { recursive: true }); rmSync(outside, { recursive: true }); }
});

test("onboarding API supports a new project without a config and starts only through its controller", async () => {
  const { dir, dist, configPath } = createWorkspace();
  rmSync(configPath);
  let started = false;
  let saved: unknown;
  const handle = await createSettingsServer(configPath, { distPath: dist, onboarding: {
    status: () => ({ active: true, root: dir }),
    save: input => { saved = input; },
    start: async () => { started = true; },
  } });
  try {
    const config = await (await handle.fetch(`${handle.url}/api/config`)).json();
    assert.equal(config.onboarding.active, true);
    assert.equal(config.project.fileKey, "");
    assert.equal(config.notify, null);
    const state = await (await handle.fetch(`${handle.url}/api/onboarding`)).json();
    assert.equal(state.root, dir);
    const response = await handle.fetch(`${handle.url}/api/onboarding`, { method: "POST", headers: { "Content-Type": "application/json", "X-Elf-Request": "1" }, body: JSON.stringify({ tokenPath: "tokens.css" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(saved, { tokenPath: "tokens.css" });
    assert.equal(started, false);
    const start = await handle.fetch(`${handle.url}/api/onboarding/start`, { method: "POST", headers: { "X-Elf-Request": "1" } });
    assert.equal(start.status, 200);
    assert.equal(started, true);
  } finally { await handle.close(); rmSync(dir, { recursive: true }); }
});

test("settings cannot write configuration through a symlink", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const target = join(dir, "original-config.json");
  const original = readFileSync(configPath, "utf8");
  writeFileSync(target, original);
  rmSync(configPath);
  symlinkSync(target, configPath);
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const response = await handle.fetch(`${handle.url}/api/config`, { method: "PATCH", headers: { "Content-Type": "application/json", "X-Elf-Request": "1" }, body: JSON.stringify({ notify: { enabled: false } }) });
    assert.notEqual(response.status, 200);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally { await handle.close(); rmSync(dir, { recursive: true }); }
});

import { reopenSettingsServer, verifySettingsServer } from "../src/settings.js";
test("settings reuse requires proof of both machine identity and the selected project", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const handle = await createSettingsServer(configPath, { distPath: dist, identityToken: "settings-proof-test-secret" });
  try {
    assert.equal(await verifySettingsServer(handle.url, configPath, "settings-proof-test-secret"), true);
    assert.equal(await verifySettingsServer(handle.url, configPath, "wrong-identity"), false);
    const other = join(dir, "other.json"); writeFileSync(other, readFileSync(configPath, "utf8"));
    assert.equal(await verifySettingsServer(handle.url, other, "settings-proof-test-secret"), false);
  } finally { await handle.close(); rmSync(dir, { recursive: true }); }
});

test("Slack test messages require the explicit local action and use the saved connection", async () => {
  const { dir, dist, configPath } = createWorkspace();
  const realFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    if (String(input) === SLACK_WEBHOOK_URL) { sent += 1; assert.equal(init?.method, "POST"); return new Response("ok", { status: 200 }); }
    return realFetch(input, init);
  }) as typeof fetch;
  const handle = await createSettingsServer(configPath, { distPath: dist });
  try {
    const blocked = await handle.fetch(`${handle.url}/api/slack/test`, { method: "POST" });
    assert.equal(blocked.status, 403); assert.equal(sent, 0);
    const testMessage = await handle.fetch(`${handle.url}/api/slack/test`, { method: "POST", headers: { "X-Elf-Request": "1" } });
    assert.equal(testMessage.status, 200); assert.equal(sent, 1);
  } finally { globalThis.fetch = realFetch; await handle.close(); rmSync(dir, { recursive: true }); }
});

test("Settings API requires a private session and consumes bootstrap links once", async () => {
  const {dir, dist, configPath} = createWorkspace();
  const handle = await createSettingsServer(configPath, {distPath: dist, identityToken: "private-settings-key"});
  try {
    assert.equal((await fetch(`${handle.url}/api/config`)).status, 401);
    const bootstrap = new URLSearchParams(new URL(handle.publicUrl).hash.slice(1)).get("elf")!;
    const exchange = () => fetch(`${handle.url}/api/session`, {method: "POST", headers: {"X-Elf-Request": "1", "X-Elf-Bootstrap": bootstrap}});
    const first = await exchange(); assert.equal(first.status, 200);
    const {session} = await first.json() as {session: string};
    assert.equal((await exchange()).status, 401);
    assert.equal((await fetch(`${handle.url}/api/config`, {headers: {"X-Elf-Session": session}})).status, 200);
    assert.equal(await reopenSettingsServer(handle.url, configPath, "wrong-key"), null);
    const reopened = await reopenSettingsServer(handle.url, configPath, "private-settings-key");
    assert.ok(reopened?.includes("#elf=")); assert.notEqual(reopened, handle.publicUrl);
  } finally { await handle.close(); rmSync(dir, {recursive: true}); }
});

test("drift report viewing requires a private session and refuses linked files", async () => {
  const {dir, dist, configPath} = createWorkspace();
  const handle = await createSettingsServer(configPath, {distPath: dist});
  try {
    assert.equal((await fetch(`${handle.url}/api/report`)).status, 401);
    assert.equal((await handle.fetch("/api/report")).status, 404);
    const markdown = "## Report\n\n<script>alert('untrusted')</script>\n";
    writeFileSync(join(dir, "drift-report.md"), markdown);
    const viewed = await handle.fetch("/api/report"); assert.equal(viewed.status, 200);
    assert.equal((await viewed.json() as any).markdown, markdown);
    rmSync(join(dir, "drift-report.md"));
    symlinkSync(configPath, join(dir, "drift-report.md"));
    assert.equal((await handle.fetch("/api/report")).status, 400);
  } finally {await handle.close(); rmSync(dir, {recursive: true});}
});

import {reopenCompatibleSettingsServer} from "../src/settings.js";
test("Settings advertises API capabilities and refuses incompatible process reuse", async () => {
  const {dir, dist, configPath} = createWorkspace();
  const identity = "capability-test-identity";
  const handle = await createSettingsServer(configPath, {distPath: dist, identityToken: identity});
  const realFetch = globalThis.fetch;
  try {
    assert.equal((await fetch(`${handle.url}/api/runtime`)).status, 401);
    const capabilities = await (await handle.fetch("/api/runtime")).json() as any;
    assert.equal(capabilities.apiVersion, 2); assert.equal(capabilities.managed, false);
    assert.ok(await reopenCompatibleSettingsServer(handle.url, configPath, identity));
    await assert.rejects(reopenCompatibleSettingsServer(handle.url, configPath, identity, true), /incompatible Elf server/);
    const unsupported = await handle.fetch("/api/project/resources", {method: "POST", headers: {"X-Elf-Request": "1"}});
    assert.equal(unsupported.status, 409); assert.match((await unsupported.json() as any).error, /require elf start/);
    const missing = await handle.fetch("/api/missing"); assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type")!, /json/);
    globalThis.fetch = (async (input: any, init?: RequestInit) => String(input).endsWith("/api/runtime") ? new Response("Not found", {status: 404}) : realFetch(input, init)) as typeof fetch;
    await assert.rejects(reopenCompatibleSettingsServer(handle.url, configPath, identity), /Stop it with Ctrl\+C/);
  } finally {globalThis.fetch = realFetch; await handle.close(); rmSync(dir, {recursive: true});}
});
