import assert from "node:assert/strict";
import { test } from "node:test";
import type { DriftConfig } from "../src/types.js";
import {
  DEFAULT_EVENT_TYPES,
  generatePasscode,
  listWebhooks,
  registerWebhooks,
} from "../src/webhook.js";

const config: DriftConfig = {
  figma: { fileKey: "abc123", apiTokenEnv: "FIGMA_API_TOKEN", source: "variables", teamId: "" },
  codebase: { source: "auto", path: "./tailwind.config.js" },
  modeName: null,
  nameMapping: {},
};

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

const calls: CapturedCall[] = [];

function stubFetch(handler: (url: string, init?: RequestInit) => Response): void {
  calls.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("generatePasscode returns a 48-char hex string, unique per call", () => {
  const a = generatePasscode();
  const b = generatePasscode();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
});

test("listWebhooks parses the response and builds the right query", async () => {
  stubFetch(() =>
    json({ webhooks: [{ id: "wh1", event_type: "FILE_VARIABLES_UPDATE", endpoint: "https://x.dev", status: "ACTIVE" }] }),
  );
  const webhooks = await listWebhooks("abc 123", "token");
  assert.equal(webhooks.length, 1);
  assert.equal(webhooks[0].id, "wh1");
  assert.match(calls[0].url, /\/v2\/webhooks\?context=file&context_id=abc%20123$/);
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers["X-Figma-Token"], "token");
});

test("listWebhooks returns empty when no webhooks key", async () => {
  stubFetch(() => json({}));
  assert.deepEqual(await listWebhooks("abc", "t"), []);
});

test("listWebhooks surfaces API errors with status", async () => {
  stubFetch(() => new Response('{"err":"nope"}', { status: 401 }));
  await assert.rejects(() => listWebhooks("abc", "t"), /Figma API returned 401/);
});

test("registerWebhooks creates missing webhooks with the right payload", async () => {
  stubFetch((url, init) => {
    if (init?.method === "POST") return json({ id: "wh-new" });
    return json({ webhooks: [] });
  });
  const results = await registerWebhooks(config, "t", "https://worker.dev", "passcode123");
  assert.deepEqual(results, ["FILE_VARIABLES_UPDATE: created (wh-new)", "FILE_VARIABLES_CREATE: created (wh-new)", "FILE_VARIABLES_REMOVE: created (wh-new)"]);

  const posts = calls.filter((c) => c.init?.method === "POST");
  assert.equal(posts.length, 3);
  const body = JSON.parse(posts[0].init?.body as string);
  assert.equal(body.event_type, "FILE_VARIABLES_UPDATE");
  assert.equal(body.context, "file");
  assert.equal(body.context_id, "abc123");
  assert.equal(body.endpoint, "https://worker.dev");
  assert.equal(body.passcode, "passcode123");
});

test("registerWebhooks skips already-registered matching webhooks", async () => {
  stubFetch(() =>
    json({
      webhooks: DEFAULT_EVENT_TYPES.map((event_type, i) => ({
        id: `wh${i}`,
        event_type,
        endpoint: "https://worker.dev",
        status: "ACTIVE",
      })),
    }),
  );
  const results = await registerWebhooks(config, "t", "https://worker.dev", "passcode123");
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.endsWith(": already registered (wh0)") || /already registered \(wh\d\)/.test(r)));
  assert.equal(calls.filter((c) => c.init?.method !== undefined).length, 0);
});

test("registerWebhooks updates the endpoint when it changed", async () => {
  stubFetch((url, init) => {
    if (init?.method === "PUT") return json({});
    return json({
      webhooks: [{ id: "wh1", event_type: "FILE_VARIABLES_UPDATE", endpoint: "https://old.dev" }],
    });
  });
  const results = await registerWebhooks(config, "t", "https://new.dev", "passcode123");
  assert.match(results[0], /endpoint updated \(wh1\)/);
  const put = calls.find((c) => c.init?.method === "PUT");
  assert.ok(put, "expected a PUT request");
  assert.match(put.url, /\/v2\/webhooks\/wh1$/);
  const body = JSON.parse(put.init?.body as string);
  assert.equal(body.endpoint, "https://new.dev");
});

test("registerWebhooks honors custom eventTypes from config", async () => {
  stubFetch(() => json({ webhooks: [] }));
  const custom: DriftConfig = {
    ...config,
    webhook: { endpoint: "https://worker.dev", eventTypes: ["FILE_VARIABLES_UPDATE"], passcodeEnv: "FIGMA_WEBHOOK_PASSCODE" },
  };
  const results = await registerWebhooks(custom, "t", "https://worker.dev", "passcode123");
  assert.equal(results.length, 1);
  assert.match(results[0], /FILE_VARIABLES_UPDATE: created/);
});
