import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { Bridge } from "../src/bridge.js";
import { silentLogger } from "../src/logger.js";
import {
  PAIRING_CODE_TTL_MS,
  createPairingCode,
  formatPairingCode,
  issueSession,
  normalizePairingCode,
  verifySession,
} from "../src/pairing.js";
import { AUTH_FAILED_CODE, type BridgeReadyMessage } from "../src/protocol.js";
import { waitFor } from "./helpers/plugin-connection.js";

const TOKEN = "test-token-0123456789";

function connect(port: number, query: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`closed before opening (code ${code})`)));
  });
}

function connectReady(
  port: number,
  query: string,
): Promise<{ socket: WebSocket; message: BridgeReadyMessage }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
    const timer = setTimeout(() => reject(new Error("no ready message arrived")), 2000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve({ socket, message: JSON.parse(data.toString()) as BridgeReadyMessage });
    });
    socket.once("error", reject);
    socket.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`closed before ready (code ${code})`));
    });
  });
}

function closed(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

test("pairing codes are grouped, normalized and single-use friendly", () => {
  const pairing = createPairingCode(1000, 5000);
  assert.match(pairing.code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(pairing.expiresAt, 6000);
  assert.equal(PAIRING_CODE_TTL_MS, 5 * 60 * 1000);
  assert.equal(normalizePairingCode(pairing.code.toUpperCase()), normalizePairingCode(pairing.code));
  assert.equal(formatPairingCode(normalizePairingCode(pairing.code)), pairing.code);
});

test("session secrets are signed, expiring and key-specific", () => {
  const now = 1_000_000;
  const issued = issueSession(TOKEN, now, 60_000);
  assert.equal(verifySession(TOKEN, issued.session, now), issued.expiresAt);
  assert.equal(verifySession(TOKEN, issued.session, issued.expiresAt), null);
  assert.equal(verifySession("another-token", issued.session, now), null);
  assert.equal(verifySession(TOKEN, issued.session.replace(/.$/, "x"), now), null);
});

test("pairs with the printed code, then reconnects with the saved session", async () => {
  const bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 500, logger: silentLogger });
  const port = await bridge.start();
  const pairing = bridge.pairingCode;
  assert.ok(pairing);

  const paired = await connectReady(port, `code=${encodeURIComponent(pairing.code)}`);
  const first = paired.socket;
  const ready = paired.message;
  assert.equal(ready.type, "ready");
  assert.ok(ready.session);
  assert.ok(ready.sessionExpiresAt);
  assert.equal(bridge.isConnected, true);
  assert.equal(bridge.pairingCode, null, "the code is consumed by the first pair");

  first.close(1000);
  await waitFor(() => !bridge.isConnected);

  const resumed = await connectReady(port, `session=${encodeURIComponent(ready.session)}`);
  const second = resumed.socket;
  const reconnected = resumed.message;
  assert.equal(reconnected.type, "ready");
  assert.equal(reconnected.session, undefined, "saved sessions are not reissued");
  assert.equal(bridge.isConnected, true);

  // The consumed code can never pair a second file.
  const stale = await connect(port, `code=${encodeURIComponent(pairing.code)}`);
  assert.equal(await closed(stale), AUTH_FAILED_CODE);

  second.close();
  await bridge.stop();
});

test("rejects an invalid or expired session", async () => {
  const bridge = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
  const port = await bridge.start();

  const bad = await connect(port, "session=not-a-real-session");
  assert.equal(await closed(bad), AUTH_FAILED_CODE);
  assert.equal(bridge.isConnected, false);

  await bridge.stop();
});

test("rejects an expired pairing code", async () => {
  const bridge = new Bridge({ token: TOKEN, port: 0, logger: silentLogger, pairingCodeTtlMs: 1 });
  const port = await bridge.start();
  const pairing = bridge.pairingCode;
  assert.ok(pairing);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(bridge.pairingCode, null);

  const socket = await connect(port, `code=${encodeURIComponent(pairing.code)}`);
  assert.equal(await closed(socket), AUTH_FAILED_CODE);

  await bridge.stop();
});

test("sessions survive a server restart but die when the token rotates", async () => {
  const first = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
  const firstPort = await first.start();
  const pairing = first.pairingCode;
  assert.ok(pairing);
  const paired = await connectReady(firstPort, `code=${encodeURIComponent(pairing.code)}`);
  const ready = paired.message;
  assert.ok(ready.session);
  paired.socket.close();
  await first.stop();

  const second = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
  const secondPort = await second.start();
  const resumed = await connectReady(secondPort, `session=${encodeURIComponent(ready.session)}`);
  assert.equal(resumed.message.type, "ready");
  assert.equal(second.isConnected, true);
  resumed.socket.close();
  await second.stop();

  const rotated = new Bridge({ token: "another-token-012345", port: 0, logger: silentLogger });
  const rotatedPort = await rotated.start();
  const rejected = await connect(rotatedPort, `session=${encodeURIComponent(ready.session)}`);
  assert.equal(await closed(rejected), AUTH_FAILED_CODE);
  await rotated.stop();
});

test("the /control lane still requires the token, not a pairing code", async () => {
  const bridge = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
  const port = await bridge.start();
  const pairing = bridge.pairingCode;
  assert.ok(pairing);

  const paired = await connectReady(port, `code=${encodeURIComponent(pairing.code)}`);
  paired.socket.close();

  const control = new WebSocket(`ws://127.0.0.1:${port}/control?code=${encodeURIComponent(pairing.code)}`);
  assert.equal(await new Promise<number>((resolve) => control.once("close", (code) => resolve(code))), AUTH_FAILED_CODE);
  await bridge.stop();
});
