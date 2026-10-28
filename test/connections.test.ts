import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startConnection, finishSlackConnection } from "../src/connection-service.js";
import { readFigmaAccount, writeFigmaAccount, figmaAccessToken, removeFigmaAccount } from "../src/figma/account.js";
import { verifyPublicFile } from "../src/figma/file-identity.js";
import { storeVerificationLimit, readVerificationLimit, verificationLimitMessage } from '../src/figma/verification-limit.js';

test('verification deadlines persist beyond 24 hours and contain no credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'elf-limit-deadline-')); const oldPath = process.env.ELF_FIGMA_ACCOUNT_PATH;
  process.env.ELF_FIGMA_ACCOUNT_PATH = join(root, 'account.json');
  try {
    const value = storeVerificationLimit('deadlineFile', new Headers({'Retry-After':'2592000','X-Figma-Plan-Tier':'pro','X-Figma-Rate-Limit-Type':'low'}));
    assert.ok(value.retryAt > Date.now() + 29 * 86400000);
    assert.deepEqual(readVerificationLimit('deadlineFile'), value);
    assert.match(verificationLimitMessage(value), /Retry after .* UTC/);
    assert.ok(Buffer.byteLength(verificationLimitMessage(value)) <= 123);
    assert.equal(readVerificationLimit('anotherFile'), null);
  } finally { if (oldPath === undefined) delete process.env.ELF_FIGMA_ACCOUNT_PATH; else process.env.ELF_FIGMA_ACCOUNT_PATH = oldPath; rmSync(root,{recursive:true,force:true}); }
});

test("rate-limited file verification observes a cooldown instead of retrying every reconnect", async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-figma-rate-")); const oldPath = process.env.ELF_FIGMA_ACCOUNT_PATH;
  process.env.ELF_FIGMA_ACCOUNT_PATH = join(root, "account.json");
  try {
    writeFigmaAccount({accessToken: "test-token", refreshToken: "test-refresh", expiresAt: Date.now() + 3600_000, origin: "https://console.test"});
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response(null, {status: 429, headers: {"Retry-After": "120"}}); }) as typeof fetch;
    for (let i = 0; i < 2; i++) await assert.rejects(verifyPublicFile("rateLimitedFile", {nonce: "e".repeat(64)}, fetchImpl), /rate-limited/);
    assert.equal(calls, 1);
  } finally { if (oldPath === undefined) delete process.env.ELF_FIGMA_ACCOUNT_PATH; else process.env.ELF_FIGMA_ACCOUNT_PATH = oldPath; rmSync(root, {recursive: true, force: true}); }
});

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

test("public file verification renews an early-rejected token once and still rejects denied access", async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-figma-renew-proof-"));
  const oldPath = process.env.ELF_FIGMA_ACCOUNT_PATH; const originalFetch = globalThis.fetch;
  process.env.ELF_FIGMA_ACCOUNT_PATH = join(root, "account.json");
  const nonce = "c".repeat(64); let renewals = 0; let requests = 0;
  try {
    writeFigmaAccount({accessToken: "rejected-before-expiry", refreshToken: "private-refresh-token", expiresAt: Date.now() + 3600_000, origin: "https://console.test"});
    globalThis.fetch = (async (url: URL) => {
      assert.equal(url.href, "https://console.test/api/local-connect/figma/refresh");
      renewals++;
      return Response.json({accessToken: "renewed-access", expiresAt: Date.now() + 3600_000});
    }) as typeof fetch;
    await verifyPublicFile("file12345", {nonce}, (async (_url: URL, init: RequestInit) => {
      requests++;
      if (requests === 1) return Response.json({err: "Request denied"}, {status: 403});
      assert.equal((init.headers as Record<string, string>).Authorization, "Bearer renewed-access");
      return Response.json({document: {sharedPluginData: {elf: {fileProof: nonce}}}});
    }) as typeof fetch);
    assert.equal(renewals, 1); assert.equal(requests, 2);
    requests = 0;
    await assert.rejects(verifyPublicFile("file12345", {nonce}, (async () => {
      requests++; return Response.json({err: "Request denied"}, {status: 403});
    }) as typeof fetch), /Figma denied file access/);
    assert.equal(renewals, 2); assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldPath === undefined) delete process.env.ELF_FIGMA_ACCOUNT_PATH; else process.env.ELF_FIGMA_ACCOUNT_PATH = oldPath;
    rmSync(root, {recursive: true, force: true});
  }
});
