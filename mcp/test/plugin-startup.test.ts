import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

function ui() {
  const elements = new Map<string, any>();
  const messages: any[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const document = { body: { dataset: {phase: "loading"} }, getElementById(key: string) {
    if (!elements.has(key)) elements.set(key, { value: "", hidden: false, textContent: "", listeners: {} as any,
      addEventListener(event: string, listener: unknown) { this.listeners[event] = listener; },
      classList: {toggle() {}, add() {}, remove() {}} });
    return elements.get(key);
  }};
  const window: any = {};
  const parent = {postMessage(message: any) { messages.push(message.pluginMessage); }};
  const context = {window, parent, document, crypto: webcrypto, TextEncoder,
    setTimeout(fn: () => void) { timers.set(++id, fn); return id; }, clearTimeout(key: number) { timers.delete(key); }};
  const html = readFileSync(new URL("../../bridge-plugin/ui.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(match[1], context);
  return {window, parent, document, elements, messages, timers};
}

test("Desktop messages without a Window source finish loading only on the private channel", () => {
  const app = ui(); const channel = app.messages[0].channel;
  assert.match(channel, /^[a-f0-9]{64}$/);
  const message = {type: "context", channel, file: {name: "Design system", key: "file"}, bridge: {host: "localhost:8765", session: ""}};
  app.window.onmessage({source: app.parent, data: {pluginMessage: {...message, channel: "wrong"}}});
  assert.equal(app.document.body.dataset.phase, "loading");
  app.window.onmessage({source: null, data: {pluginMessage: message}});
  assert.equal(app.document.body.dataset.phase, "disconnected");
  assert.equal(app.elements.get("file-key").textContent, "file");
  assert.equal(app.timers.size, 0);
});

test("a stalled or failed context displays an actionable retry instead of spinning forever", () => {
  const app = ui();
  [...app.timers.values()][0]();
  assert.equal(app.elements.get("retry-context").hidden, false);
  assert.match(app.elements.get("context-detail").textContent, /did not respond/);
  app.elements.get("retry-context").listeners.click();
  assert.equal(app.messages.length, 2);
  assert.equal(app.messages[1].channel, app.messages[0].channel);
  app.window.onmessage({source: null, data: {pluginMessage: {type: "context-error", channel: app.messages[0].channel, message: "Storage unavailable"}}});
  assert.equal(app.elements.get("context-detail").textContent, "Storage unavailable");
  assert.equal(app.elements.get("context-spinner").hidden, true);
});

function main(getAsync: (key: string) => Promise<unknown>) {
  const messages: any[] = []; const timers = new Map<number, () => void>(); let id = 0;
  const figma: any = {root: {name: "Design system"}, fileKey: "file", apiVersion: "1.0.0", showUI() {},
    clientStorage: {getAsync, async setAsync() {}}, ui: {postMessage(message: any) { messages.push(message); }}};
  runInNewContext(readFileSync(new URL("../../bridge-plugin/code.js", import.meta.url), "utf8"), {figma, __html__: "", console,
    setTimeout(fn: () => void) {timers.set(++id, fn); return id;}, clearTimeout(key: number) {timers.delete(key);}});
  return {figma, messages, timers};
}
const channel = "a".repeat(64);
test("plugin context tolerates malformed saved host values", async () => {
  const plugin = main(async key => key === "elf-bridge-host" ? 42 : undefined);
  await plugin.figma.ui.onmessage({type: "context", channel});
  assert.equal(plugin.messages[0].type, "context");
  assert.equal(plugin.messages[0].bridge.host, "localhost:8765");
  assert.equal(plugin.messages[0].channel, channel);
});

test("plugin context surfaces rejected and stalled storage reads", async () => {
  const failed = main(async () => {throw new Error("Storage unavailable");});
  await failed.figma.ui.onmessage({type: "context", channel});
  assert.equal(failed.messages[0].type, "context-error");
  assert.equal(failed.messages[0].message, "Storage unavailable");
  const stalled = main(() => new Promise(() => {}));
  const pending = stalled.figma.ui.onmessage({type: "context", channel});
  [...stalled.timers.values()][0](); await pending;
  assert.equal(stalled.messages[0].type, "context-error");
  assert.match(stalled.messages[0].message, /did not respond/);
});
