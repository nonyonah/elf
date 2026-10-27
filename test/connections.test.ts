import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startConnection, finishSlackConnection } from "../src/connection-service.js";
import { readFigmaAccount, writeFigmaAccount, figmaAccessToken, removeFigmaAccount } from "../src/figma/account.js";
import { verifyPublicFile } from "../src/figma/file-identity.js";

test("local account grants use HTTPS and proof-bound loopback callbacks without app secrets", async () => {
  const flow = startConnection("figma", 3210); const url = new URL(flow.url);
  assert.equal(url.searchParams.get("return_uri"), "http://127.0.0.1:3210/api/figma/broker-callback");
  assert.match(flow.state, /^[a-f0-9]{64}$/); assert.equal(url.searchParams.get("challenge")?.length, 43);
  assert.equal(url.searchParams.has("client_secret"), false);
  await assert.rejects(finishSlackConnection("x", flow.verifier, flow.origin), /Invalid connection grant/);
});

test("Figma account storage is private, rejects links, and refresh cannot restore a disconnected account", async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-figma-account-")); const oldPath = process.env.ELF_FIGMA_ACCOUNT_PATH; const oldFetch = globalThis.fetch;
  process.env.ELF_FIGMA_ACCOUNT_PATH = join(root, "account.json");
  try {
    writeFigmaAccount({accessToken: "old-token", refreshToken: "private-refresh-token", expiresAt: 1, origin: "https://console.test"});
    assert.equal(statSync(process.env.ELF_FIGMA_ACCOUNT_PATH).mode & 0o777, 0o600);
    assert.equal(readFigmaAccount()?.accessToken, "old-token");
    globalThis.fetch = (async () => {removeFigmaAccount(); return Response.json({accessToken: "new-token", expiresAt: Date.now() + 3600_000});}) as typeof fetch;
    await assert.rejects(figmaAccessToken(), /changed during refresh/);
    assert.equal(readFigmaAccount(), null);
    symlinkSync(join(root, "another.json"), process.env.ELF_FIGMA_ACCOUNT_PATH);
    assert.throws(() => writeFigmaAccount({accessToken: "token", refreshToken: "private-refresh", expiresAt: Date.now() + 3600_000, origin: "https://console.test"}), /link/);
  } finally {globalThis.fetch = oldFetch; if (oldPath === undefined) delete process.env.ELF_FIGMA_ACCOUNT_PATH; else process.env.ELF_FIGMA_ACCOUNT_PATH = oldPath; rmSync(root, {recursive: true, force: true});}
});

test("public file identity requires the fresh document proof and retries a save delay", async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-figma-proof-")); const oldPath = process.env.ELF_FIGMA_ACCOUNT_PATH;
  process.env.ELF_FIGMA_ACCOUNT_PATH = join(root, "account.json");
  try {
    writeFigmaAccount({accessToken: "private-account-token", refreshToken: "private-refresh-token", expiresAt: Date.now() + 3600_000, origin: "https://console.test"});
    const nonce = "a".repeat(64); let reads = 0;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      assert.equal(url.origin, "https://api.figma.com"); assert.equal(url.searchParams.get("plugin_data"), "shared");
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer private-account-token");
      reads++; return Response.json({document: {sharedPluginData: {elf: {fileProof: reads === 1 ? "copied-old-proof" : nonce}}}});
    }) as typeof fetch;
    await verifyPublicFile("file12345", {nonce}, fetchImpl);
    assert.equal(reads, 2);
    await assert.rejects(verifyPublicFile("file12345", {nonce: "bad"}, fetchImpl), /Invalid/);
    await assert.rejects(verifyPublicFile("file12345", {nonce}, (async () => Response.json({document: {sharedPluginData: {elf: {fileProof: "different-file"}}}})) as typeof fetch), /does not match/);
  } finally {if (oldPath === undefined) delete process.env.ELF_FIGMA_ACCOUNT_PATH; else process.env.ELF_FIGMA_ACCOUNT_PATH = oldPath; rmSync(root, {recursive: true, force: true});}
});
