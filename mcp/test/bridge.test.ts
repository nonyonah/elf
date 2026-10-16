import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Bridge } from "../src/bridge.js";
import { BridgeError } from "../src/errors.js";
import { silentLogger } from "../src/logger.js";
import { AUTH_FAILED_CODE, REPLACED_CODE } from "../src/protocol.js";
import { FakePlugin, rawConnect, waitFor } from "./helpers/plugin-connection.js";

const TOKEN = "test-token-0123456789";

describe("bridge", () => {
  let bridge: Bridge;
  let port: number;

  before(async () => {
    bridge = new Bridge({ token: TOKEN, port: 0, timeoutMs: 500, logger: silentLogger });
    port = await bridge.start();
  });

  after(async () => {
    await bridge.stop();
  });

  test("binds to 127.0.0.1 only", async () => {
    assert.ok(port > 0);
    assert.equal(bridge.status.port, port);
    assert.equal(bridge.status.address, "127.0.0.1");
  });

  test("round trips a request and matches the response id", async () => {
    const seen: Record<string, unknown>[] = [];
    const plugin = await FakePlugin.connect({
      port,
      token: TOKEN,
      handlers: {
        status: (params) => {
          seen.push(params);
          return { file: { name: "Core", key: "abc123" } };
        },
      },
    });

    assert.equal(bridge.isConnected, true);

    const result = await bridge.request<{ file: { name: string } }>("status", { verbose: true });

    assert.deepEqual(result, { file: { name: "Core", key: "abc123" } });
    assert.equal(plugin.requests.length, 1);
    assert.equal(plugin.requests[0].type, "request");
    assert.equal(plugin.requests[0].method, "status");
    assert.deepEqual(plugin.requests[0].params, { verbose: true });
    assert.ok(plugin.requests[0].id.length > 0);
    assert.deepEqual(seen, [{ verbose: true }]);

    // Every request gets its own id, so concurrent calls cannot cross wires.
    const [, second] = await Promise.all([bridge.request("status"), bridge.request("status")]);
    assert.deepEqual(second, result);
    assert.notEqual(plugin.requests[1].id, plugin.requests[2].id);

    plugin.close();
  });

  test("records the file reported by the plugin status message", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({}) } });
    plugin.sendStatus({ name: "Design System", key: "fig-file-key" });
    await waitFor(() => bridge.status.file !== null);

    assert.equal(bridge.status.connected, true);
    assert.equal(bridge.status.file?.name, "Design System");
    assert.equal(bridge.status.file?.key, "fig-file-key");
    assert.ok(bridge.status.connectedAt);

    plugin.close();
  });

test("rejects a connection with a bad token", async () => {
    // The TCP/WebSocket handshake still completes, then the bridge closes the
    // socket with 4001 — exactly what a browser WebSocket in the plugin sees.
    const plugin = await FakePlugin.connect({ port, token: "wrong-token-abcdefgh" });
    const closed = await plugin.waitForClose();

    assert.equal(closed.code, AUTH_FAILED_CODE);
    assert.equal(closed.reason, "unauthorized");
    assert.equal(plugin.requests.length, 0, "no request should ever reach an unauthorized plugin");
  });

test("leaves the bridge unconnected after a rejected handshake", async () => {
    const bare = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
    const barePort = await bare.start();

    const bad = await FakePlugin.connect({ port: barePort, token: "wrong-token-abcdefgh" });
    assert.equal((await bad.waitForClose()).code, AUTH_FAILED_CODE);

    assert.equal(bare.isConnected, false);
    await assert.rejects(
      () => bare.request("list_collections"),
      (error: BridgeError) => {
        assert.equal(error.code, "not-connected");
        assert.match(error.message, /open the Elf Bridge plugin in Figma/);
        return true;
      },
    );

    await bare.stop();
  });

test("a rejected handshake does not disturb an authorized session", async () => {
    const good = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({ ok: true }) } });
    const bad = await FakePlugin.connect({ port, token: "wrong-token-abcdefgh" });

    assert.equal((await bad.waitForClose()).code, AUTH_FAILED_CODE);
    assert.equal(bridge.isConnected, true);
    assert.deepEqual(await bridge.request("status"), { ok: true });

    good.close();
  });

test("rejects a connection with no token at all", async () => {
    const bare = new Bridge({ token: TOKEN, port: 0, logger: silentLogger });
    const barePort = await bare.start();

    const socket = await rawConnect(barePort, "/");
    const code = await new Promise<number>((resolve) => socket.once("close", resolve));
    assert.equal(code, AUTH_FAILED_CODE);
    assert.equal(bare.isConnected, false);

    await bare.stop();
  });

  test("times out when the plugin never answers and stops tracking the request", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, silent: true });

    await assert.rejects(
      () => bridge.request("list_variables", { collection: "Core" }, { timeoutMs: 80 }),
      (error: BridgeError) => {
        assert.equal(error.code, "timeout");
        assert.match(error.message, /Timed out after 80ms/);
        assert.match(error.message, /list_variables/);
        return true;
      },
    );

    // A late answer for a timed-out request is dropped instead of crashing.
    const late = plugin.requests[0];
    plugin.send({ type: "response", id: late.id, ok: true, result: { collections: [] } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    plugin.close();
  });

  test("surfaces plugin errors verbatim, including plan limits", async () => {
    const planLimit =
      "in addMode: Limited to 4 modes only";
    const plugin = await FakePlugin.connect({
      port,
      token: TOKEN,
      handlers: {
        create_collection: () => {
          throw new Error(planLimit);
        },
      },
    });

    await assert.rejects(
      () => bridge.request("create_collection", { name: "Core" }),
      (error: BridgeError) => {
        assert.equal(error.code, "plugin");
        assert.equal(error.message, planLimit);
        return true;
      },
    );

    plugin.close();
  });

  test("fails in-flight requests when the plugin disconnects", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, silent: true });

    const pending = bridge.request("list_variables", {}, { timeoutMs: 3000 });
    await waitFor(() => plugin.requests.length === 1);
    plugin.terminate();

    await assert.rejects(pending, (error: BridgeError) => {
      assert.equal(error.code, "disconnected");
      assert.match(error.message, /plugin disconnected/);
      return true;
    });

    assert.equal(bridge.isConnected, false);
    await assert.rejects(() => bridge.request("list_variables"), /No Figma plugin connected/);
  });

  test("ignores malformed and unrelated messages", async () => {
    const plugin = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({ ok: true }) } });

    plugin.send({ type: "response", id: "does-not-exist", ok: true, result: {} } as never);
    await assert.doesNotReject(() => bridge.request("status"));

    plugin.close();
  });

  test("keeps the newest plugin connection and closes the older one", async () => {
    const first = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({ from: "first" }) } });
    const second = await FakePlugin.connect({ port, token: TOKEN, handlers: { status: () => ({ from: "second" }) } });

    const closed = await first.waitForClose();
    assert.equal(closed.code, REPLACED_CODE);

    assert.deepEqual(await bridge.request("status"), { from: "second" });

    second.close();
  });
});
