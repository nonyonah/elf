import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FakePlugin } from "../mcp/test/helpers/plugin-connection.js";

const bin = process.env.ELF_TEST_INSTALLED_BIN ?? fileURLToPath(new URL("../bin/elf-tokens.js", import.meta.url));
const token = "isolated-startup-test-credential";

async function eventually<T>(fn: () => T | Promise<T>, accept: (value: T) => boolean, detail: () => string): Promise<T> {
  // Cold tsx imports can exceed 20 seconds on busy desktop and CI hosts.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (accept(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Startup condition timed out: ${detail()}`);
}

test("startup pairs, saves setup, monitors edits, and restarts a configured project", { timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-start-"));
  const configPath = join(root, "elf.config.json");
  writeFileSync(join(root, "system.md"), "# Example design system\nBrand color is #6633ff.\n");
  writeFileSync(join(root, "tokens.css"), ":root {}\n");
  let child: ReturnType<typeof spawn> | null = null;
  let plugin: FakePlugin | null = null;
  let logs = "";
  let session = "";
  const request: typeof fetch = (input, init = {}) => {
    const headers = new Headers(init.headers); headers.set("X-Elf-Session", session);
    return fetch(input, { ...init, headers });
  };
  const launch = async (): Promise<{ url: string; port: number }> => {
    logs = "";
    child = spawn(process.execPath, [bin, "start", "--no-open", "--settings-port", "0", "--config", configPath], {
      cwd: root,
      env: { ...process.env, ELF_MCP_TOKEN: token, ELF_MCP_PORT: "0", ELF_SETTINGS_NO_OPEN: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", data => { logs += data; });
    child.stderr!.on("data", data => { logs += data; });
    child.on("error", error => { logs += error.message; });
    await eventually(() => logs, value => /Settings: http:\/\/127\.0\.0\.1:\d+/.test(value), () => logs);
    const publicUrl = /Settings: (http:\/\/127\.0\.0\.1:\d+\/#elf=[a-f0-9]+)/.exec(logs)![1];
    const opened = await fetch(new URL("/api/session", publicUrl), { method: "POST", headers: { "X-Elf-Request": "1", "X-Elf-Bootstrap": new URLSearchParams(new URL(publicUrl).hash.slice(1)).get("elf")! } });
    session = (await opened.json()).session;
    return { url: new URL(publicUrl).origin, port: Number(/bridge listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(logs)![1]) };
  };
  const stop = async (): Promise<void> => {
    plugin?.terminate(); plugin = null;
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    child = null;
  };
  try {
    const { url, port } = await launch();
    const post = (path: string, body?: unknown) => request(url + path, { method: "POST", headers: { "X-Elf-Request": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const extractionResponse = await post('/api/project/prepare-design-system', {path:'system.md'});
    assert.equal(extractionResponse.status,200);
    const extraction=await extractionResponse.json();assert.equal(extraction.canApply,false);
    const validationResponse=await post('/api/project/validate-design-system',{id:extraction.id,draft:extraction.draft});
    assert.equal(validationResponse.status,200);const validation=await validationResponse.json();
    assert.equal(validation.reviewReady,false);assert.equal(validation.canApply,false);
    const refresh = await post("/api/onboarding/pairing");
    assert.equal(refresh.status, 200);
    const refreshBody = await refresh.text();
    assert.equal(refreshBody.includes("code"), false, "the browser must not receive the pairing code");
    await eventually(() => logs, value => value.includes("New pairing code:"), () => logs);
    const input = { tokenPath: "auto", source: "auto", autoSync: false };
    assert.equal((await post("/api/onboarding", input)).status, 400, "unpaired setup cannot be saved");
    plugin = await FakePlugin.connect({ port, token, handlers: { list_collections: () => ({ collections: [] }), list_variables: () => ({ variables: [] }), list_components: () => ({components: []}) } });
    plugin.sendStatus({ key: "startup-test-file", name: "Startup design system" });
    await eventually(async () => (await request(url + "/api/onboarding")).json(), value => value.bridge.file?.key === "startup-test-file", () => logs);
    assert.equal((await post("/api/onboarding", input)).status, 200);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).runtime.setupComplete, false, "saving progress must not complete onboarding before Slack returns");
    assert.equal((await (await request(url + "/api/onboarding")).json()).running, false);
    assert.equal((await post("/api/onboarding/start")).status, 200);
    const clean = await eventually(async () => (await request(url + "/api/onboarding")).json(), value => value.lastCheck?.status === "clean", () => logs);
    assert.equal(clean.running, true);
    writeFileSync(join(root, "tokens.css"), ":root { --color-primary: #123456; }\n");
    const drift = await eventually(async () => (await request(url + "/api/onboarding")).json(), value => value.lastCheck?.status === "drift", () => logs);
    assert.equal(drift.lastCheck.total, 1);
    mkdirSync(join(root, "components"));
    writeFileSync(join(root, "components", "Button.tsx"), "export function Button() { return <button>Save</button>; }");
    const discovered = await eventually(async () => (await request(url + "/api/onboarding")).json(), value => value.lastCheck?.total === 2, () => logs);
    assert.equal(discovered.lastCheck.status, "drift");
    assert.equal(plugin.requests.some(request => /upsert|create|delete|rename/.test(request.method)), false, "monitoring must not mutate Figma");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).runtime.setupComplete, true);
    await stop();
    const restarted = await launch();
    plugin = await FakePlugin.connect({ port: restarted.port, token, handlers: { list_collections: () => ({ collections: [] }), list_variables: () => ({ variables: [] }), list_components: () => ({components: []}) } });
    plugin.sendStatus({ key: "startup-test-file", name: "Startup design system" });
    // A configured project resumes automatically when the plugin reconnects.
    await eventually(async () => (await request(restarted.url + "/api/onboarding")).json(), value => value.bridge.file?.key === "startup-test-file", () => logs);
    const resumed = await eventually(async () => (await request(restarted.url + "/api/onboarding")).json(), value => value.lastCheck?.status === "drift", () => logs);
    assert.equal(resumed.configured, true);
  } finally { await stop(); rmSync(root, { recursive: true }); }
});
