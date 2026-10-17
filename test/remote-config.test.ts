import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { DriftConfig } from "../src/core/types.js";
import {
  applyRemoteConfig,
  fetchRemoteConfig,
  isRemoteConfig,
  readRemoteCache,
  unwrapRemoteConfigEnvelope,
} from "../src/remote-config.js";

function makeConfig(): DriftConfig {
  return {
    figma: { fileKey: "file123", apiTokenEnv: "FIGMA_API_TOKEN", source: "variables" },
    codebase: { path: "src/styles", source: "css" },
    modeName: null,
    modeStrategy: "modes",
    nameMapping: { "color-primary-500": "primary-500" },
    deprecations: [{ type: "token", name: "color-legacy", reason: "retired", removeBy: "2026-01-01" }],
  };
}

function responder(
  sequence: (Response | Error)[],
): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** A CONTRACT.md-shaped config response: `{ schema, config, updatedAt, etag? }`. */
const envelope = (config: unknown, etag?: string): Record<string, unknown> => ({
  schema: 1,
  config,
  updatedAt: "2026-10-17T09:00:00Z",
  ...(etag ? { etag } : {}),
});

test("fetchRemoteConfig: 200 caches the config with its ETag, then revalidates with 304", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  const cacheFile = join(dir, ".elf", "config.remote.json");
  const remote = { nameMapping: { "color-primary-500": "brand-500" }, modeStrategy: "collections" as const };
  const first = responder([jsonResponse(200, envelope(remote, "W/\"v1\""), { etag: "W/\"v1\"" })]);
  const result1 = await fetchRemoteConfig({ url: "https://console.test/", token: "t", cacheFile, fetchImpl: first.fetchImpl });

  assert.equal(result1.source, "remote");
  assert.deepEqual(result1.config, remote);
  assert.equal(first.calls[0].url, "https://console.test/api/v1/projects/me/config");
  const headers = first.calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer t");
  assert.equal(headers["If-None-Match"], undefined, "first fetch has no cache to revalidate");

  const cached = readRemoteCache(cacheFile);
  assert.equal(cached?.etag, "W/\"v1\"");
  assert.deepEqual(cached?.config, remote);
  assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).config.modeStrategy, "collections");

  const second = responder([jsonResponse(304, null)]);
  const result2 = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: second.fetchImpl });
  assert.equal(result2.source, "remote");
  assert.deepEqual(result2.config, remote);
  assert.equal((second.calls[0].init.headers as Record<string, string>)["If-None-Match"], "W/\"v1\"");
});

test("fetchRemoteConfig falls back to the cache when the dashboard is unreachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  const cacheFile = join(dir, "config.remote.json");
  const remote = { deprecations: [] };
  const warm = responder([jsonResponse(200, envelope(remote))]);
  await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: warm.fetchImpl });

  const down = responder([new Error("ECONNREFUSED")]);
  const result = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: down.fetchImpl });
  assert.equal(result.source, "cache");
  assert.deepEqual(result.config, remote);

  const serverError = responder([jsonResponse(500, { error: { code: "server_error" } })]);
  const result2 = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: serverError.fetchImpl });
  assert.equal(result2.source, "cache");
});

test("fetchRemoteConfig: no cache and no dashboard means local, never an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  const cacheFile = join(dir, "config.remote.json");
  const down = responder([new Error("ENOTFOUND")]);
  const result = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: down.fetchImpl });
  assert.deepEqual(result, { config: null, source: "none" });
});

test("fetchRemoteConfig rejects malformed payloads and keeps the cache intact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  const cacheFile = join(dir, "config.remote.json");
  const good = responder([jsonResponse(200, envelope({ nameMapping: { a: "b" } }))]);
  await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: good.fetchImpl });

  const invalidConfig = responder([jsonResponse(200, envelope({ nameMapping: { a: 42 } }))]);
  const result = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: invalidConfig.fetchImpl });
  assert.equal(result.source, "cache");
  assert.deepEqual(result.config, { nameMapping: { a: "b" } });

  const noEnvelope = responder([jsonResponse(200, { nameMapping: { a: "b" } })]);
  const result2 = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: noEnvelope.fetchImpl });
  assert.equal(result2.source, "cache", "flat bodies are not the contract — the envelope is required");

  const garbage = responder([jsonResponse(200, "not an object")]);
  const result3 = await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: garbage.fetchImpl });
  assert.equal(result3.source, "cache");
});

test("fetchRemoteConfig uses the body etag when the header is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  const cacheFile = join(dir, "config.remote.json");
  const first = responder([jsonResponse(200, envelope({ modeStrategy: "modes" }, "\"cfg-7\""))]);
  await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: first.fetchImpl });
  assert.equal(readRemoteCache(cacheFile)?.etag, "\"cfg-7\"");

  const second = responder([jsonResponse(304, null)]);
  await fetchRemoteConfig({ url: "https://console.test", token: "t", cacheFile, fetchImpl: second.fetchImpl });
  assert.equal((second.calls[0].init.headers as Record<string, string>)["If-None-Match"], "\"cfg-7\"");
});

test("applyRemoteConfig: the dashboard wins per field, local stays for the rest", () => {
  const local = makeConfig();
  const merged = applyRemoteConfig(local, { modeStrategy: "collections", modeName: "all" });
  assert.equal(merged.modeStrategy, "collections");
  assert.equal(merged.modeName, "all");
  assert.deepEqual(merged.nameMapping, local.nameMapping);
  assert.deepEqual(merged.deprecations, local.deprecations);
  assert.deepEqual(merged.figma, local.figma);
  assert.deepEqual(merged.codebase, local.codebase);

  const full = applyRemoteConfig(local, {
    deprecations: [],
    nameMapping: {},
    modeStrategy: "modes",
    modeName: null,
  });
  assert.deepEqual(full.deprecations, [], "an empty remote deprecations list clears the local one");
  assert.deepEqual(full.nameMapping, {});
  assert.equal(full.modeName, null, "null is a value, not a missing field");

  assert.deepEqual(applyRemoteConfig(local, null), local);
  assert.deepEqual(applyRemoteConfig(local, {}), local);
});

test("isRemoteConfig validates shapes", () => {
  assert.equal(isRemoteConfig({}), true);
  assert.equal(isRemoteConfig({ deprecations: [], nameMapping: { a: "b" }, modeStrategy: "modes", modeName: null }), true);
  assert.equal(isRemoteConfig({ modeName: ["Light", "Dark"] }), true);
  assert.equal(isRemoteConfig(null), false);
  assert.equal(isRemoteConfig([]), false);
  assert.equal(isRemoteConfig("remote"), false);
  assert.equal(isRemoteConfig({ deprecations: {} }), false);
  assert.equal(isRemoteConfig({ nameMapping: ["a"] }), false);
  assert.equal(isRemoteConfig({ nameMapping: { a: 1 } }), false);
  assert.equal(isRemoteConfig({ modeStrategy: "both" }), false);
  assert.equal(isRemoteConfig({ modeName: [1, 2] }), false);
  assert.equal(isRemoteConfig({ modeName: 42 }), false);
});

test("unwrapRemoteConfigEnvelope requires the CONTRACT.md envelope", () => {
  assert.deepEqual(unwrapRemoteConfigEnvelope(envelope({ modeStrategy: "modes" }, "\"cfg-1\"")), {
    config: { modeStrategy: "modes" },
    etag: "\"cfg-1\"",
  });
  assert.deepEqual(unwrapRemoteConfigEnvelope({ schema: 1, config: {} }), { config: {} });
  assert.equal(unwrapRemoteConfigEnvelope(null), null);
  assert.equal(unwrapRemoteConfigEnvelope("remote"), null);
  assert.equal(unwrapRemoteConfigEnvelope({ config: { modeStrategy: "nope" } }), null);
  assert.equal(unwrapRemoteConfigEnvelope({ nameMapping: { a: "b" } }), null);
});

test("readRemoteCache tolerates missing, corrupt and invalid files", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-remote-"));
  assert.equal(readRemoteCache(join(dir, "nope.json")), null);

  const corrupt = join(dir, "corrupt.json");
  writeFileSync(corrupt, "{ not json");
  assert.equal(readRemoteCache(corrupt), null);

  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, JSON.stringify({ fetchedAt: "x", config: { modeStrategy: "nope" } }));
  assert.equal(readRemoteCache(invalid), null);
});
