import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function ui() {
  const sockets: any[] = [];
  class Socket {static OPEN = 1; readyState = 1; onmessage: any; onclose: any; sent: string[] = []; closed: any; constructor(_url: string) {sockets.push(this);} send(value: string) {this.sent.push(value);} close(code: number, reason: string) {this.closed = {code, reason};}}
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
  const context = {window, parent, document, crypto: webcrypto, TextEncoder, URL, URLSearchParams, WebSocket: Socket,
    setTimeout(fn: () => void) { timers.set(++id, fn); return id; }, clearTimeout(key: number) { timers.delete(key); }};
  const html = readFileSync(new URL("../../bridge-plugin/ui.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(match[1], context);
  return {window, parent, document, elements, messages, timers, sockets};
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

function main(getAsync: (key: string) => Promise<unknown>, codeUrl = new URL("../../bridge-plugin/code.js", import.meta.url)) {
  const messages: any[] = []; const timers = new Map<number, () => void>(); let id = 0;
  const stored = new Map<string, unknown>(); const data = new Map<string, string>(); const shared = new Map<string, string>();
  const figma: any = {root: {name: "Design system", getPluginData: (key: string) => data.get(key) ?? "", setPluginData: (key: string, value: string) => data.set(key, value), setSharedPluginData: (namespace: string, key: string, value: string) => shared.set(`${namespace}:${key}`, value)}, fileKey: "file", apiVersion: "1.0.0", showUI() {},
    clientStorage: {getAsync: async (key: string) => stored.get(key) ?? getAsync(key), async setAsync(key: string, value: unknown) {stored.set(key, value);}, async deleteAsync(key: string) {stored.delete(key);}}, ui: {postMessage(message: any) { messages.push(message); }}};
  runInNewContext(readFileSync(codeUrl, "utf8"), {figma, __html__: "", console,
    setTimeout(fn: () => void) {timers.set(++id, fn); return id;}, clearTimeout(key: number) {timers.delete(key);}});
  return {figma, messages, timers, stored, data, shared};
}
const channel = "a".repeat(64);
test("the public bundle always prompts for a file link even when a development import exposes fileKey", async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/build-public-bridge.mjs", import.meta.url))]);
  const manifest = JSON.parse(readFileSync(new URL("../../dist/bridge-plugin-public/manifest.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.networkAccess.allowedDomains, ["ws://localhost:8765"]);
  assert.equal(manifest.enablePrivatePluginApi, undefined);
  const plugin = main(async () => undefined, new URL("../../dist/bridge-plugin-public/code.js", import.meta.url));
  await plugin.figma.ui.onmessage({type: "context", channel});
  assert.equal(plugin.messages[0].type, "file-link-required");
  const app = ui();
  app.window.onmessage({source: null, data: {pluginMessage: {...plugin.messages[0], channel: app.messages[0].channel}}});
  assert.equal(app.elements.get("file-link-form").hidden, false);
  await plugin.figma.ui.onmessage({type: "set-file-link", channel, url: "https://www.figma.com/design/publicFile123/Test"});
  const context = plugin.messages.find(message => message.type === "context");
  assert.equal(context.file.key, "publicFile123");
  assert.equal(context.file.verification.nonce, channel);
});
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


test("development manifest enables real file identity and missing identity never becomes draft", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../bridge-plugin/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.enablePrivatePluginApi, true);
  const plugin = main(async () => undefined);
  plugin.figma.fileKey = undefined;
  await plugin.figma.ui.onmessage({type: "context", channel});
  assert.equal(plugin.messages[0].type, "file-link-required");
  assert.equal(plugin.messages.some(message => message.file?.key === "draft"), false);
});

test("hiding the running plugin preserves its channel and can be reversed", async () => {
  const plugin = main(async () => undefined); let hidden = false; let notification: any;
  plugin.figma.ui.hide = () => {hidden = true;}; plugin.figma.ui.show = () => {hidden = false;};
  plugin.figma.notify = (_message: string, options: any) => {notification = options;};
  await plugin.figma.ui.onmessage({type: "context", channel});
  await plugin.figma.ui.onmessage({type: "hide-ui", channel: "wrong"}); assert.equal(hidden, false);
  await plugin.figma.ui.onmessage({type: "hide-ui", channel}); assert.equal(hidden, true);
  notification.button.action(); assert.equal(hidden, false);
  await plugin.figma.ui.onmessage({type: "hide-ui", channel});
  await plugin.figma.ui.onmessage({type: "request", channel, id: "show", method: "show_ui"});
  assert.equal(hidden, false);
  assert.equal(plugin.messages.at(-1).ok, true);
});

test("public plugin asks for a link and produces a fresh document proof without a private API", async () => {
  const plugin = main(async () => undefined); plugin.figma.fileKey = undefined;
  await plugin.figma.ui.onmessage({type: "context", channel});
  await plugin.figma.ui.onmessage({type: "set-file-link", channel, url: "https://www.figma.com.evil/design/file12345"});
  assert.equal(plugin.data.has("elf-file-key"), false);
  await plugin.figma.ui.onmessage({type: "set-file-link", channel, url: "https://www.figma.com/design/file12345/Design"});
  const context = [...plugin.messages].reverse().find(message => message.type === "context");
  assert.equal(context.file.key, "file12345");
  assert.equal(context.file.verification.nonce, channel);
  assert.equal(plugin.shared.get("elf:fileProof"), channel);
  const next = "b".repeat(64);
  await plugin.figma.ui.onmessage({type: "context", channel: next});
  assert.equal(plugin.shared.get("elf:fileProof"), next);
});

test("saved plugin sessions are isolated by file", async () => {
  const plugin = main(async () => undefined);
  await plugin.figma.ui.onmessage({type: "context", channel});
  await plugin.figma.ui.onmessage({type: "save-session", channel, session: "session-for-A"});
  plugin.figma.fileKey = "file-B";
  await plugin.figma.ui.onmessage({type: "context", channel});
  assert.equal([...plugin.messages].reverse().find(message => message.type === "context").bridge.session, "");
  await plugin.figma.ui.onmessage({type: "save-session", channel, session: "session-for-B"});
  plugin.figma.fileKey = "file";
  await plugin.figma.ui.onmessage({type: "context", channel});
  assert.equal([...plugin.messages].reverse().find(message => message.type === "context").bridge.session, "session-for-A");
});

test("public link entry uses the private UI channel", () => {
  const app = ui();
  app.window.onmessage({data: {pluginMessage: {type: "file-link-required", channel: app.messages[0].channel}}});
  assert.equal(app.elements.get("file-link-form").hidden, false);
  assert.equal(app.elements.get("context-spinner").hidden, true);
  app.document.getElementById("figma-file-link").value = "https://www.figma.com/design/file12345";
  app.elements.get("use-file-link").listeners.click();
  assert.equal(app.messages.at(-1).type, "set-file-link");
  assert.equal(app.messages.at(-1).channel, app.messages[0].channel);
});

test("public UI refuses old bridges and never forwards writes before verification", () => {
  for (const capability of [undefined, 1]) {
    const app = ui();
    app.window.onmessage({data: {pluginMessage: {type: "context", channel: app.messages[0].channel, file: {name: "Public", key: "file12345", verification: {nonce: "a".repeat(64)}}, bridge: {host: "localhost:8765", session: ""}}}});
    app.document.getElementById("code").value = "abcd-efgh-jkmn";
    app.elements.get("pair").listeners.click();
    const socket = app.sockets[0];
    socket.onmessage({data: JSON.stringify({type: "ready", fileVerification: capability})});
    if (capability === undefined) {assert.equal(socket.closed.code, 4003); assert.equal(socket.sent.length, 0); continue;}
    const before = app.messages.length;
    socket.onmessage({data: JSON.stringify({type: "request", id: "write", method: "create_collection"})});
    assert.equal(app.messages.length, before);
    socket.onmessage({data: JSON.stringify({type: "file-verified"})});
    socket.onmessage({data: JSON.stringify({type: "request", id: "write", method: "create_collection"})});
    assert.equal(app.messages.at(-1).type, "request");
  }
});


test("changing a file link retires the old socket before reconnecting with new authorization", () => {
  const app = ui(); const channel = app.messages[0].channel;
  const context = {type: "context", channel, file: {name: "Public", key: "file12345", verification: {nonce: "a".repeat(64), method: "strict"}}, bridge: {host: "localhost:8765", session: ""}};
  app.window.onmessage({data: {pluginMessage: context}});
  app.document.getElementById("code").value = "abcd-efgh-jkmn";
  app.elements.get("pair").listeners.click();
  const old = app.sockets[0];
  app.elements.get("change-file-link").listeners.click();
  assert.equal(old.closed.code, 1000);
  assert.equal(old.onmessage, null);
  assert.equal(old.onclose, null);
  app.window.onmessage({data: {pluginMessage: {...context, file: {...context.file, verification: {...context.file.verification, method: "plugin"}}}}});
  app.elements.get("pair").listeners.click();
  assert.equal(app.sockets.length, 2);
  const socket = app.sockets[1];
  socket.onmessage({data: JSON.stringify({type: "ready", fileVerification: 1, documentApproval: 1})});
  socket.onmessage({data: JSON.stringify({type: "document-approval-required"})});
  assert.match(app.elements.get("pairing-detail").textContent, /Pairing succeeded/);
  assert.equal(app.document.body.dataset.phase, "pairing");
});
