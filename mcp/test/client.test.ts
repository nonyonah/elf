import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test, mock } from "node:test";
import { Bridge } from "../src/bridge.js";
import { BridgeClient, createBridgeClient } from "../src/client.js";
import { BridgeError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { FakePlugin } from "./helpers/plugin-connection.js";

const TOKEN = "test-token-0123456789";

const isBridgeError = (code: string, fragment?: string) => (error: unknown) => {
  assert.ok(error instanceof BridgeError, `expected a BridgeError, got ${error}`);
  assert.equal(error.code, code);
  if (fragment) assert.match(error.message, new RegExp(fragment));
  return true;
};

describe("control client (/control lane)", () => {
  let bridge: Bridge;
  let port: number;

  before(async () => {
    bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 500, logger: silentLogger });
    port = await bridge.start();
  });

  after(async () => {
    await bridge.stop();
  });

  test("dials /control and round-trips tool calls", async () => {
    const plugin = await FakePlugin.connect({
      port,
      token: TOKEN,
      handlers: { status: () => ({ file: { name: "Core" } }) },
    });
    const client = await createBridgeClient({ port, token: TOKEN, timeoutMs: 500 });
    try {
      const result = await client.call<{ file: { name: string } }>("status", { verbose: true });
      assert.deepEqual(result, { file: { name: "Core" } });
      assert.equal(plugin.requests.length, 1);
      assert.equal(plugin.requests[0].method, "status");
      assert.deepEqual(plugin.requests[0].params, { verbose: true });
    } finally {
      client.close();
      plugin.close();
    }
  });

  test("control clients come and go without touching the plugin lane", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({ ok: 1 }) } });
    const first = await createBridgeClient({ port, token: TOKEN, timeoutMs: 500 });
    const second = await createBridgeClient({ port, token: TOKEN, timeoutMs: 500 });
    try {
      await Promise.all([first.call("status"), second.call("status")]);
      assert.equal(plugin.requests.length, 2);

      first.close();
      assert.equal(bridge.isConnected, true, "plugin must stay connected when a control client leaves");
      assert.deepEqual(await second.call("status"), { ok: 1 });
    } finally {
      first.close();
      second.close();
      plugin.close();
    }
  });

  test("plugin errors keep their exact message", async () => {
    const plugin = await FakePlugin.connect({
      port,
      token: TOKEN,
      handlers: {
        upsert_component: () => {
          throw new Error('Component set "Button" already exists with a different variant roster.');
        },
      },
    });
    const client = await createBridgeClient({ port, token: TOKEN, timeoutMs: 500 });
    try {
      await assert.rejects(
        () => client.call("upsert_component", { name: "Button" }),
        isBridgeError("plugin", "different variant roster"),
      );
    } finally {
      client.close();
      plugin.close();
    }
  });

  test("a call with no plugin connected fails with the plugin hint", async () => {
    const client = await createBridgeClient({ port, token: TOKEN, timeoutMs: 500 });
    try {
      await assert.rejects(
        () => client.call("status"),
        isBridgeError("not-connected", "open the Elf Bridge plugin in Figma"),
      );
    } finally {
      client.close();
    }
  });

  test("a wrong token fails fast with an auth explanation", async () => {
    await assert.rejects(
      () => createBridgeClient({ port, token: "wrong-token-abcdefgh", timeoutMs: 500 }),
      isBridgeError("auth", "verify the bridge identity"),
    );
  });

  test("an unreachable server fails fast with a start hint", async () => {
    const probe = createServer();
    const closedPort = await new Promise<number>((resolve) => {
      probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        const resolved = typeof address === "object" && address ? address.port : 0;
        probe.close(() => resolve(resolved));
      });
    });

    await assert.rejects(
      () => createBridgeClient({ port: closedPort, token: TOKEN, timeoutMs: 500 }),
      isBridgeError("transport", "Cannot reach the Elf bridge"),
    );
  });

  test("a silent plugin ends in a timeout error", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, silent: true });
    const client = await createBridgeClient({ port, token: TOKEN, timeoutMs: 150 });
    try {
      await assert.rejects(() => client.call("status"), isBridgeError("timeout", "Timed out after 150ms"));
    } finally {
      client.close();
      plugin.close();
    }
  });

  test("stopping the bridge drops control clients", async () => {
    const scratch = new Bridge({ token: TOKEN, port: 0, timeoutMs: 500, logger: silentLogger });
    const scratchPort = await scratch.start();
    const client = await createBridgeClient({ port: scratchPort, token: TOKEN, timeoutMs: 500 });
    await scratch.stop();

    // Depending on timing, the close lands either before the call (transport)
    // or while it is in flight (disconnected) — both are clear failures.
    await assert.rejects(
      () => client.call("status"),
      (error: unknown) => {
        assert.ok(error instanceof BridgeError, `expected a BridgeError, got ${error}`);
        assert.ok(
          error.code === "transport" || error.code === "disconnected",
          `unexpected code: ${error.code}`,
        );
        return true;
      },
    );
    client.close();
  });
});

import { acquireBridge } from "../src/runtime.js";

test("runtime refuses an authenticated host missing secure file verification", async () => {
  const owner = await acquireBridge({token: TOKEN, port: 0, timeoutMs: 500});
  const original = BridgeClient.prototype.call;
  const mocked = mock.method(BridgeClient.prototype, "call", function (this: BridgeClient, method: string, ...args: any[]) {
    if (method === "__elf_capabilities") return Promise.resolve({});
    return Reflect.apply(original, this, [method, ...args]);
  });
  try {
    await assert.rejects(acquireBridge({token: TOKEN, port: owner.connection.status.port!, timeoutMs: 500}), /older Elf shared bridge.*bridge --stop/);
  } finally {mocked.mock.restore(); await owner.close();}
});

test("MCP runtime reuses an authenticated bridge without taking ownership", async () => {
  const owner = await acquireBridge({ token: TOKEN, port: 0, timeoutMs: 500 });
  const port = owner.connection.status.port!;
  try {
    assert.equal(owner.owned, true);
    const attached = await acquireBridge({ token: TOKEN, port, timeoutMs: 500 });
    try {
      assert.equal(attached.owned, false);
      assert.equal(attached.pairingCode, null);
      assert.equal(attached.connection.status.port, port);
      const previousCode = owner.pairingCode!.code;
      const refreshed = await attached.refreshPairingCode();
      assert.notEqual(refreshed.code, previousCode);
      assert.match(refreshed.code, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
      const plugin = await FakePlugin.connect({ port, token: TOKEN });
      try {
        const status = await new Promise<boolean>((resolve) => {
          if (attached.connection.isConnected) return resolve(true);
          const off = attached.connection.onStatus((value) => { if (value.connected) { off(); resolve(true); } });
        });
        assert.equal(status, true);
      } finally { await plugin.close(); }
    } finally { await attached.close(); }
    assert.equal(owner.connection.status.port, port);
    const probe = await createBridgeClient({ port, token: TOKEN });
    probe.close();
    await assert.rejects(acquireBridge({ token: "a-different-secret", port, timeoutMs: 500 }), /verify the bridge identity/);
  } finally { await owner.close(); }
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bridge transactions isolate controllers and reject a changed target file", async () => {
  const bridge = new Bridge({ token: TOKEN, port: 0 });
  const port = await bridge.start();
  const plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: { get_node: params => ({ node: params.nodeId }) } });
  plugin.sendStatus({ key: "file-one", name: "First" });
  const a = await createBridgeClient({ port, token: TOKEN }); const b = await createBridgeClient({ port, token: TOKEN });
  try {
    await a.call("__elf_lock", { fileKey: "file-one" });
    let answered = false;
    const waiting = b.call("get_node", { nodeId: "other" }).then(value => { answered = true; return value; });
    await a.call("get_node", { nodeId: "own" });
    assert.equal(answered, false);
    plugin.sendStatus({ key: "file-two", name: "Second" });
    await new Promise(resolve => setTimeout(resolve, 30));
    await assert.rejects(a.call("upsert_component", { name: "Must not write" }), /file changed/);
    await a.call("__elf_unlock");
    await waiting;
    assert.equal(plugin.requests.some(request => request.method === "upsert_component"), false);
  } finally { a.close(); b.close(); plugin.terminate(); await bridge.stop(); }
});

test("shared host survives a client exit and authenticates reused connections", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-shared-host-"));
  const server = createServer(); server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const config = { token: TOKEN, port, timeoutMs: 1000, persistent: true, sessionStorePath: join(dir, "sessions.json") };
  let a: Awaited<ReturnType<typeof acquireBridge>> | undefined; let b: typeof a;
  try {
    a = await acquireBridge(config); b = await acquireBridge(config);
    assert.deepEqual(await a.connection.request("__elf_capabilities"), {fileVerification: 1, accountRenewal: 1, documentApproval: 1, projectPanel: 1});
    assert.equal(a.owned, false); assert.equal(b.owned, false);
    await a.close(); a = undefined;
    const refreshed = await b.refreshPairingCode(); assert.ok(refreshed.code);
    await b.connection.request("__elf_shutdown");
    await b.close(); b = undefined;
  } finally { await a?.close(); await b?.close(); rmSync(dir, { recursive: true }); }
});

import { WebSocketServer } from "ws";
test("a spoofed bridge cannot obtain controller credentials or skip server verification", async () => {
  const server = new WebSocketServer({host: "127.0.0.1", port: 0});
  await new Promise<void>(resolve => server.once("listening", resolve));
  let handshake = "", received = 0;
  server.on("connection", (socket, request) => {
    handshake = request.url ?? "";
    socket.on("message", () => received++);
    socket.send(JSON.stringify({type: "challenge", nonce: "a".repeat(64), proof: "0".repeat(64)}));
  });
  try {
    const port = (server.address() as {port: number}).port;
    await assert.rejects(createBridgeClient({port, token: TOKEN}), /verify the bridge identity/);
    assert.equal(handshake.includes(TOKEN), false);
    assert.match(handshake, /^\/control\?nonce=[a-f0-9]{64}$/);
    assert.equal(received, 0);
  } finally { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
