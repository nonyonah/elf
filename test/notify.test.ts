import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffTokens, type DriftResult } from "../src/core/diff.js";
import {
  notificationItems,
  buildNotifyMessage,
  decideNotification,
  driftFingerprint,
  postNotification,
  readNotifyState,
  resolveNotifyWebhook,
  resolveReportUrl,
  writeNotifyState,
  type NotifyMeta,
} from "../src/notify.js";
import { recordActivity } from "../src/activity.js";
import { deliverSyncNotifications } from "../src/sync-notifications.js";
import { SLACK_WEBHOOK_FILE } from "../src/slack.js";
import type { NotifyConfig, Token } from "../src/core/types.js";

const SLACK_WEBHOOK_URL = [
  "https://hooks.slack.com",
  "services",
  "T00000000",
  "B00000000",
  "XXXXXXXXXXXXXXXXXXXXXXXX",
].join("/");

const meta: NotifyMeta = {
  fileKey: "abc123",
  figmaSource: "variables (bridge)",
  codebaseSource: "tailwind",
  checkedAt: "2026-06-01T00:00:00.000Z",
};

const token = (name: string, value: string, mode?: string): Token => ({
  name,
  category: "color",
  value,
  ...(mode === undefined ? {} : { mode }),
});

const drifting = (): DriftResult =>
  diffTokens([token("color/bg", "#FFFFFF")], [token("color/bg", "#EEEEEE")], {});

test("the fingerprint is stable for the same items and changes when they do", () => {
  const a = diffTokens([token("a", "1"), token("c", "5")], [token("a", "2"), token("b", "3")], {});
  const b = diffTokens([token("a", "1"), token("c", "5")], [token("a", "2"), token("b", "3")], {});
  assert.equal(driftFingerprint(a), driftFingerprint(b));

  const changed = diffTokens([token("a", "1"), token("c", "5")], [token("a", "9"), token("b", "3")], {});
  assert.notEqual(driftFingerprint(a), driftFingerprint(changed));

  const reordered = diffTokens([token("c", "5"), token("a", "1")], [token("b", "3"), token("a", "2")], {});
  assert.equal(driftFingerprint(a), driftFingerprint(reordered), "item order does not matter");
});

test("a first report alerts only when there is something to say", () => {
  const withDrift = decideNotification(null, drifting());
  assert.equal(withDrift.send, true);
  assert.equal(withDrift.reason, "first-report");

  const clean = decideNotification(null, diffTokens([], [], {}));
  assert.equal(clean.send, false);
  assert.equal(clean.reason, "unchanged");

  const notes = diffTokens([], [], {});
  notes.safeToRemoveFromDeprecations.push({ kind: "token", name: "color/legacy" });
  assert.equal(decideNotification(null, notes).send, true, "informational notes are worth a first report");
});

test("unchanged state is skipped and any change sends", () => {
  const result = drifting();
  const state = { fingerprint: driftFingerprint(result), driftFound: true };

  const same = decideNotification(state, drifting());
  assert.equal(same.send, false);
  assert.equal(same.reason, "unchanged");

  const changed = decideNotification(state, diffTokens([token("color/bg", "#000000")], [token("color/bg", "#EEEEEE")], {}));
  assert.equal(changed.send, true);
  assert.equal(changed.reason, "state-changed");

  const resolved = decideNotification(state, diffTokens([token("color/bg", "#EEEEEE")], [token("color/bg", "#EEEEEE")], {}));
  assert.equal(resolved.send, true);
  assert.match(buildNotifyMessage(diffTokens([token("color/bg", "#EEEEEE")], [token("color/bg", "#EEEEEE")], {}), meta, "slack", state).text, /resolved/);
});

test("onlyOnChange false sends even when the fingerprint is unchanged", () => {
  const result = drifting();
  const state = { fingerprint: driftFingerprint(result), driftFound: true };

  const same = decideNotification(state, drifting(), false);
  assert.equal(same.send, true);
  assert.equal(same.reason, "state-changed");

  const first = decideNotification(null, diffTokens([], [], {}), false);
  assert.equal(first.send, true);
  assert.equal(first.reason, "first-report");
});

test("drift messages carry the counts and cap the item list", () => {
  const result = diffTokens(
    Array.from({ length: 12 }, (_, i) => token(`color/t${i}`, "#FFFFFF")),
    Array.from({ length: 12 }, (_, i) => token(`color/t${i}`, "#000000")),
    {},
  );

  const slack = buildNotifyMessage(result, meta, "slack", null);
  assert.match(slack.text, /12 items/);
  assert.equal(slack.blocks?.length, 3);
  const header = slack.blocks?.[0] as { text: { text: string } };
  assert.equal(header.text.text, "Design token drift detected");

  const section = (slack.blocks?.[1] as { text: { text: string } }).text.text;
  assert.match(section, /Value mismatches: 12/);
  assert.match(section, /Missing in code: 0/);
  assert.match(section, /… and 2 more — run `elf check` to see the full report\./);
  assert.equal(section.split("\n").filter((line) => line.startsWith("• ")).length, 10);

  const context = (slack.blocks?.[2] as { elements: { text: string }[] }).elements[0].text;
  assert.match(context, /file `abc123`/);
  assert.match(context, /variables \(bridge\) vs tailwind/);
});

test("an optional url lands in the context and full-report link — Slack link, plain text for text format", () => {
  const withUrl: NotifyMeta = { ...meta, url: "https://console.elf.dev/#/p/prj_1" };
  const many = diffTokens(
    Array.from({ length: 12 }, (_, i) => token(`color/t${i}`, "#FFFFFF")),
    Array.from({ length: 12 }, (_, i) => token(`color/t${i}`, "#000000")),
    {},
  );
  const slack = buildNotifyMessage(many, withUrl, "slack", null);
  const context = (slack.blocks?.[2] as { elements: { text: string }[] }).elements[0].text;
  assert.match(context, /<https:\/\/console\.elf\.dev\/#\/p\/prj_1\|Open the report>/);
  const section = (slack.blocks?.[1] as { text: { text: string } }).text.text;
  assert.match(section, /<https:\/\/console\.elf\.dev\/#\/p\/prj_1\|see the full report>/);

  const text = buildNotifyMessage(many, withUrl, "text", null);
  assert.match(text.text, /see the full report: https:\/\/console\.elf\.dev\/#\/p\/prj_1/);
  assert.doesNotMatch(text.text, /Open the report/);
});

test("the report link prefers notify.reportUrl, then the console project page", () => {
  assert.equal(
    resolveReportUrl({
      notify: { webhookEnv: "X", format: "slack", reportUrl: "https://reports.example.com/r/1" },
      dashboard: { url: "https://console.elf.dev", projectId: "prj_1" },
    }),
    "https://reports.example.com/r/1",
  );
  assert.equal(
    resolveReportUrl({ dashboard: { url: "https://console.elf.dev/", projectId: "prj 1" } }),
    "https://console.elf.dev/#/p/prj%201",
  );
  assert.equal(resolveReportUrl({ dashboard: { url: "https://console.elf.dev" } }), undefined);
  assert.equal(resolveReportUrl({}), undefined);
});

test("mode labels and component keys appear in the item lines", () => {
  const result = diffTokens(
    [token("color/bg", "#FFFFFF", "Light"), token("color/bg", "#000000", "Dark")],
    [token("color/bg", "#EEEEEE")],
    {},
  );
  result.componentsOutOfDate.push({ name: "Button", codeKey: "Button.tsx#Button" });

  const message = buildNotifyMessage(result, meta, "slack", null);
  const section = (message.blocks?.[1] as { text: { text: string } }).text.text;
  assert.match(section, /`color\/bg` \(Light\)/);
  assert.match(section, /`color\/bg` \(Dark\)/);
  assert.match(section, /out of date: `Button` \(Button\.tsx#Button\)/);
});

test("clean states produce resolved and notes-only messages", () => {
  const previous = { fingerprint: driftFingerprint(drifting()), driftFound: true };

  const resolved = buildNotifyMessage(diffTokens([], [], {}), meta, "slack", previous);
  assert.match(resolved.text, /resolved/);
  const resolvedHeader = resolved.blocks?.[0] as { text: { text: string } };
  assert.equal(resolvedHeader.text.text, "Drift resolved");

  const notes = diffTokens([], [], {});
  notes.deprecatedStillInCode.push({ kind: "component", name: "OldCard", detail: "remove by 2026-09-01" });
  const notesMessage = buildNotifyMessage(notes, meta, "slack", null);
  assert.match(notesMessage.text, /No drift; 1 deprecation note/);
  const notesSection = (notesMessage.blocks?.[1] as { text: { text: string } }).text.text;
  assert.match(notesSection, /deprecated, still in code: `OldCard`/);
});

test("the text format posts a plain body without blocks", () => {
  const message = buildNotifyMessage(drifting(), meta, "text", null);
  assert.equal(message.blocks, undefined);
  assert.match(message.text, /Design token drift: 1 item/);
  assert.match(message.text, /• `color\/bg`: `#FFFFFF` \(Figma\) → `#EEEEEE` \(code\)/);
  assert.match(message.text, /checked 2026-06-01T00:00:00\.000Z/);
});

test("state files round-trip and old or missing files read as a first report", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-notify-"));
  const statePath = join(dir, "state.json");

  assert.equal(readNotifyState(statePath), null, "missing file");

  writeFileSync(statePath, JSON.stringify({ driftFound: true, valueMismatches: 2 }));
  assert.equal(readNotifyState(statePath), null, "status file without a fingerprint");

  writeFileSync(statePath, JSON.stringify({ fingerprint: "", driftFound: true }));
  assert.equal(readNotifyState(statePath), null, "empty fingerprint");

  writeNotifyState(statePath, { fingerprint: "abc123def456", driftFound: true });
  assert.deepEqual(readNotifyState(statePath), { fingerprint: "abc123def456", driftFound: true });
});

test("posting sends JSON for slack and plain text otherwise", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const slack = buildNotifyMessage(drifting(), meta, "slack", null);
    await postNotification("https://hooks.example/slack", "slack", slack);
    assert.equal(calls[0].url, "https://hooks.example/slack");
    const slackBody = JSON.parse(String(calls[0].init.body)) as { text: string; blocks: unknown[] };
    assert.match(slackBody.text, /Design token drift/);
    assert.ok(Array.isArray(slackBody.blocks));

    const text = buildNotifyMessage(drifting(), meta, "text", null);
    await postNotification("https://ntfy.example/topic", "text", text);
    assert.equal(calls[1].init.body, text.text, "text format posts the body as-is");
    assert.match(String((calls[1].init.headers as Record<string, string>)["Content-Type"]), /text\/plain/);

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await assert.rejects(
      () => postNotification("https://hooks.example/slack", "slack", slack),
      /webhook responded 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("notify falls back to the Slack connection saved by settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-notify-webhook-"));
  const configPath = join(dir, "elf.config.json");
  const url = SLACK_WEBHOOK_URL;
  mkdirSync(join(dir, ".elf"), { recursive: true });
  writeFileSync(join(dir, SLACK_WEBHOOK_FILE), JSON.stringify({
    url,
    channel: "design-system",
    channelId: "C123",
    teamName: "Rift Labs",
    teamId: "T123",
    configuredAt: "2026-10-24T00:00:00.000Z",
  }));

  const notify: NotifyConfig = { webhookEnv: "SLACK_WEBHOOK_URL", format: "slack", onlyOnChange: true };
  try {
    assert.deepEqual(resolveNotifyWebhook(notify, configPath, {}), { url, source: SLACK_WEBHOOK_FILE });

    const fromEnv = resolveNotifyWebhook(notify, configPath, { SLACK_WEBHOOK_URL: "https://hooks.example/env" });
    assert.deepEqual(fromEnv, { url: "https://hooks.example/env", source: "SLACK_WEBHOOK_URL" });

    assert.equal(
      resolveNotifyWebhook({ ...notify, format: "text" }, configPath, {}),
      null,
      "plain-text webhooks are env-only",
    );
    assert.equal(
      resolveNotifyWebhook(notify, join(dir, "other", "elf.config.json"), {}),
      null,
      "the Slack file is resolved next to the config",
    );
    assert.equal(resolveNotifyWebhook(undefined, configPath, {}), null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("notification deltas include only the changed item among unchanged drift", () => {
  const figma = Array.from({length: 135}, (_, i) => token(`token/${i}`, "1"));
  const code = figma.map(item => ({...item, value: "2"}));
  const previous = diffTokens(figma, code, {});
  code[34]!.value = "3";
  const next = diffTokens(figma, code, {});
  const message = buildNotifyMessage(next, meta, "slack", {fingerprint: driftFingerprint(previous), driftFound: true, items: notificationItems(previous)});
  assert.match(message.text, /0 new · 1 changed · 0 no longer reported · 134 unchanged/);
  assert.match(message.text, /token\/34/);
  assert.doesNotMatch(message.text, /token\/35/);
  assert.equal((message.blocks?.[1]?.text as {type: string}).type, "plain_text");
});

test("repeated edits to an already drifting component change its fingerprint", () => {
  const result = diffTokens([], [], {});
  result.componentsOutOfDate = [{name: "Button", codeKey: "Button.tsx#Button", codeHash: "first"}];
  const previous = driftFingerprint(result);
  result.componentsOutOfDate[0]!.codeHash = "second";
  assert.notEqual(driftFingerprint(result), previous);
});

test("verified sync notifications retry failed delivery and do not repeat applied changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "elf-sync-delivery-"));
  const path = join(root, "elf.config.json");
  const originalFetch = globalThis.fetch;
  const prior = process.env.ELF_TEST_SYNC_WEBHOOK;
  process.env.ELF_TEST_SYNC_WEBHOOK = "https://example.invalid/webhook";
  writeFileSync(path, JSON.stringify({figma: {fileKey: "test"}, codebase: {path: "tokens.css"}, notify: {webhookEnv: "ELF_TEST_SYNC_WEBHOOK", format: "slack"}}));
  recordActivity(path, "sync", "Synced", [{kind: "token", key: "color/a", name: "color/a", action: "update", before: "#111111", after: "#222222"}]);
  let posts = 0;
  try {
    globalThis.fetch = (async () => {posts++; return new Response("failed", {status: 500});}) as typeof fetch;
    await assert.rejects(deliverSyncNotifications(path));
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {posts++; assert.match(String(init.body), /color\/a/); return new Response("ok");}) as typeof fetch;
    await deliverSyncNotifications(path);
    await deliverSyncNotifications(path);
    assert.equal(posts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (prior === undefined) delete process.env.ELF_TEST_SYNC_WEBHOOK; else process.env.ELF_TEST_SYNC_WEBHOOK = prior;
    rmSync(root, {recursive: true, force: true});
  }
});
