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
    const response = await fetch(`${handle.url}/api/config`);
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
    const response = await fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notify: { onlyOnChange: false } }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const config = readConfig(configPath);
    const notify = config.notify as Record<string, unknown>;
    assert.equal(notify.onlyOnChange, false);
    assert.equal(notify.format, "slack", "onlyOnChange must not rewrite the payload format");

    const refreshed = await (await fetch(`${handle.url}/api/config`)).json();
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
    const response = await fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notify: { enabled: false } }),
    });
    assert.equal(response.status, 200);

    const config = readConfig(configPath);
    assert.equal(config.notify, undefined);

    const refreshed = await (await fetch(`${handle.url}/api/config`)).json();
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
    const response = await fetch(`${handle.url}/api/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
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
    const before = await (await fetch(`${handle.url}/api/config`)).json();
    assert.equal(before.slack.connected, true);

    const response = await fetch(`${handle.url}/api/slack/disconnect`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(existsSync(join(dir, ".elf", "slack-webhook.json")), false);

    const after = await (await fetch(`${handle.url}/api/config`)).json();
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
    const root = await fetch(`${handle.url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<title>Settings<\/title>/);

    const fallback = await fetch(`${handle.url}/settings`);
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
    const response = await fetch(`${handle.url}/api/slack/connect`, { method: "POST" });
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
    const response = await fetch(
      `${handle.url}/callback?code=nope&state=wrong`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/?slack=error");
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true });
  }
});
