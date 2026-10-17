import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffTokens } from "../src/core/diff.js";
import type { ReportMeta } from "../src/core/report.js";
import type { DriftConfig, Token } from "../src/core/types.js";
import { buildCodePushPayload, postCodeSnapshot, readGitInfo, type CodePushPayload } from "../src/push.js";

const meta: ReportMeta = {
  fileKey: "file123",
  figmaSource: "variables",
  codebaseSource: "css",
  figmaTokenCount: 2,
  codeTokenCount: 1,
  checkedAt: "2026-10-17T00:00:00.000Z",
};

const figmaTokens: Token[] = [
  { name: "color.primary", category: "color", value: "#111111", source: "figma" },
  { name: "color.accent", category: "color", value: "#0099ff", source: "figma", mode: "Light" },
];
const codeTokens: Token[] = [
  { name: "color.primary", category: "color", value: "#222222", source: "code" },
];

function makeConfig(): DriftConfig {
  return {
    figma: { fileKey: "file123", apiTokenEnv: "FIGMA_API_TOKEN", source: "variables" },
    codebase: { path: "src/styles", source: "css" },
    modeName: null,
    modeStrategy: "collections",
    nameMapping: {},
    deprecations: [],
  };
}

function makePayload(overrides: { git?: { branch: string; commit: string } } = {}): CodePushPayload {
  return buildCodePushPayload({
    source: "cli",
    config: makeConfig(),
    meta,
    figmaTokens,
    codeTokens,
    result: diffTokens(figmaTokens, codeTokens, {}),
    report: "## Design token drift report",
    ...overrides,
  });
}

test("buildCodePushPayload assembles the contract shape", () => {
  const payload = makePayload({ git: { branch: "main", commit: "abc1234" } });

  assert.equal(payload.source, "cli");
  assert.equal(payload.checkedAt, meta.checkedAt);
  assert.deepEqual(payload.git, { branch: "main", commit: "abc1234" });
  assert.deepEqual(payload.config, {
    figmaFileKey: "file123",
    figmaSource: "variables",
    codebaseSource: "css",
    modeStrategy: "collections",
    modeName: null,
  });
  assert.equal(payload.report, "## Design token drift report");

  assert.deepEqual(payload.figmaTokens, [
    { name: "color.primary", category: "color", value: "#111111" },
    { name: "color.accent", category: "color", value: "#0099ff", mode: "Light" },
  ]);
  assert.equal("source" in payload.figmaTokens[0], false, "internal source field must not leak into the payload");

  assert.equal(payload.drift.found, true);
  assert.equal(payload.drift.counts.valueMismatches, 1);
  assert.equal(payload.drift.counts.missingInCode, 1);
  assert.equal(payload.drift.counts.missingInFigma, 0);
  assert.equal("driftFound" in payload.drift.counts, false, "found owns that field; counts must not repeat it");
});

test("buildCodePushPayload omits git, components and report when absent", () => {
  const payload = makePayload();
  assert.equal("git" in payload, false);
  assert.equal("components" in payload, false);
});

function responder(sequence: (Response | Error)[]): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
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

function makeSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("postCodeSnapshot POSTs the payload with a bearer token and parses the receipt", async () => {
  const { fetchImpl, calls } = responder([jsonResponse(202, { status: "stored", snapshotId: "snap_1" })]);
  const { sleep, waits } = makeSleep();
  const outcome = await postCodeSnapshot({
    url: "https://console.test/",
    token: "elf_push_secret",
    payload: makePayload(),
    fetchImpl,
    sleep,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.body?.status, "stored");
  assert.deepEqual(waits, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://console.test/api/v1/ingest/code");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer elf_push_secret");
  assert.equal(headers["Content-Type"], "application/json");
  const sent = JSON.parse(String(calls[0].init.body)) as CodePushPayload;
  assert.equal(sent.checkedAt, meta.checkedAt);
});

test("postCodeSnapshot retries network errors with backoff, then succeeds", async () => {
  const { fetchImpl, calls } = responder([new Error("ECONNRESET"), jsonResponse(202, { status: "deduped" })]);
  const { sleep, waits } = makeSleep();
  const outcome = await postCodeSnapshot({
    url: "https://console.test",
    token: "t",
    payload: makePayload(),
    fetchImpl,
    sleep,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 2);
  assert.equal(outcome.body?.status, "deduped");
  assert.deepEqual(waits, [1000]);
  assert.equal(calls.length, 2);
});

test("postCodeSnapshot gives up after three attempts on 5xx", async () => {
  const { fetchImpl, calls } = responder([
    jsonResponse(500, { error: { code: "server_error" } }),
    jsonResponse(503, { error: { code: "server_error" } }),
    jsonResponse(502, { error: { code: "server_error" } }),
  ]);
  const { sleep, waits } = makeSleep();
  const outcome = await postCodeSnapshot({
    url: "https://console.test",
    token: "t",
    payload: makePayload(),
    fetchImpl,
    sleep,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.attempts, 3);
  assert.match(outcome.error ?? "", /502/);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(calls.length, 3);
});

test("postCodeSnapshot honors Retry-After on 429", async () => {
  const { fetchImpl } = responder([
    jsonResponse(429, { error: { code: "rate_limited" } }, { "retry-after": "2" }),
    jsonResponse(202, { status: "stored" }),
  ]);
  const { sleep, waits } = makeSleep();
  const outcome = await postCodeSnapshot({
    url: "https://console.test",
    token: "t",
    payload: makePayload(),
    fetchImpl,
    sleep,
  });

  assert.equal(outcome.ok, true);
  assert.deepEqual(waits, [2000]);
});

test("postCodeSnapshot never retries 400 or 401 and surfaces the server message", async () => {
  for (const [status, message] of [[400, "the payload had no tokens"], [401, "unknown token"]] as const) {
    const { fetchImpl, calls } = responder([
      jsonResponse(status, { error: { code: "invalid_payload", message } }),
    ]);
    const { sleep, waits } = makeSleep();
    const outcome = await postCodeSnapshot({
      url: "https://console.test",
      token: "t",
      payload: makePayload(),
      fetchImpl,
      sleep,
    });

    assert.equal(outcome.ok, false, `status ${status}`);
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.status, status);
    assert.match(outcome.error ?? "", new RegExp(message));
    assert.deepEqual(waits, []);
    assert.equal(calls.length, 1);
  }
});

test("readGitInfo returns undefined outside a git repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-push-"));
  assert.equal(readGitInfo(dir), undefined);
});
