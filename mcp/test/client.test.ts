import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, test } from "node:test";
import { Bridge } from "../src/bridge.js";
import { createBridgeClient } from "../src/client.js";
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
      isBridgeError("auth", "ELF_MCP_TOKEN"),
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
