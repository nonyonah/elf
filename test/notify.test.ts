import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { diffTokens, type DriftResult } from "../src/core/diff.js";
import {
  buildNotifyMessage,
  decideNotification,
  driftFingerprint,
  postNotification,
  readNotifyState,
  writeNotifyState,
  type NotifyMeta,
} from "../src/notify.js";
import type { Token } from "../src/core/types.js";

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
  assert.match(section, /… and 2 more — see the full report\./);
  assert.equal(section.split("\n").filter((line) => line.startsWith("• ")).length, 10);

  const context = (slack.blocks?.[2] as { elements: { text: string }[] }).elements[0].text;
  assert.match(context, /file `abc123`/);
  assert.match(context, /variables \(bridge\) vs tailwind/);
});

test("an optional url lands in the context line — Slack link, plain text for text format", () => {
  const withUrl: NotifyMeta = { ...meta, url: "https://console.elf.dev/#/p/prj_1" };
  const slack = buildNotifyMessage(drifting(), withUrl, "slack", null);
  const context = (slack.blocks?.[2] as { elements: { text: string }[] }).elements[0].text;
  assert.match(context, /<https:\/\/console\.elf\.dev\/#\/p\/prj_1\|Open the report>/);

  const text = buildNotifyMessage(drifting(), withUrl, "text", null);
  assert.match(text.text, /· https:\/\/console\.elf\.dev\/#\/p\/prj_1$/m);
  assert.doesNotMatch(text.text, /Open the report/);
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
