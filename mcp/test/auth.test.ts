import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext, Script } from "node:vm";
import { Bridge } from "../src/bridge.js";

class Socket extends EventEmitter {
  readyState = 1;
  frames: any[] = [];
  closed = false;
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  close() { this.closed = true; this.emit("close"); }
}
const token = "auth-unit-test-secret";
const nonce = "a".repeat(64);
const hmac = (key: string, text: string) => createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex");

test("controller handshake never exposes the machine secret and rejects forged proofs", () => {
  const bridge = new Bridge({token, port: 0}) as any;
  const bad = new Socket();
  bridge.accept(bad, `/control?nonce=${nonce}`);
  const challenge = bad.frames[0];
  const key = createHash("sha256").update(`control\n${token}`).digest("hex");
  assert.equal(challenge.proof, hmac(key, `server\n${nonce}\n${challenge.nonce}`));
  assert.equal(JSON.stringify(challenge).includes(token), false);
  bad.emit("message", JSON.stringify({type: "authenticate", proof: "0".repeat(64)}));
  assert.equal(bad.closed, true);
  assert.equal(bridge.controls.size, 0);
});

test("authenticated messages reject modification, reflection and replay", () => {
  const bridge = new Bridge({token, port: 0}) as any;
  const socket = new Socket();
  bridge.accept(socket, `/control?nonce=${nonce}`);
  const challenge = socket.frames[0];
  const context = `${nonce}\n${challenge.nonce}`;
  const key = createHash("sha256").update(`control\n${token}`).digest("hex");
  socket.emit("message", JSON.stringify({type: "authenticate", proof: hmac(key, `client\n${context}`)}));
  const status = socket.frames[1];
  assert.equal(status.type, "authenticated");
  assert.equal(status.proof, hmac(key, `message-server\n${context}\n1\n${status.payload}`));
  assert.throws(() => bridge.decodePlugin(socket, JSON.stringify(status)), /proof/);
  const payload = JSON.stringify({type: "call", id: "one", method: "status"});
  const frame = {type: "authenticated", sequence: 1, payload, proof: hmac(key, `message-client\n${context}\n1\n${payload}`)};
  assert.throws(() => bridge.decodePlugin(socket, JSON.stringify({...frame, payload: "modified"})), /proof/);
  assert.equal(bridge.decodePlugin(socket, JSON.stringify(frame)), payload);
  assert.throws(() => bridge.decodePlugin(socket, JSON.stringify(frame)), /frame/);
  socket.close();
});

test("generated plugin scripts parse and browser HMAC matches node crypto", () => {
  const html = readFileSync(new URL("../../bridge-plugin/ui.html", import.meta.url), "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 2);
  for (const source of scripts) new Script(source);
  const context = {TextEncoder};
  runInNewContext(scripts[0], context);
  const browser = context as any;
  const key = createHash("sha256").update(token).digest("hex");
  for (const text of ["", "server\na\nb", "Unicode ✓ " + "large".repeat(200)]) {
    assert.equal(browser.pairingHmac(key, text), hmac(key, text));
  }
});
