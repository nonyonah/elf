import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Bridge } from "../src/bridge.js";
import { acquireBridge } from "../src/runtime.js";
import { silentLogger } from "../src/logger.js";

let foreign: Bridge | null = null;
let port = 0;
let config: { token: string; port: number; timeoutMs: number };

before(async () => {
  foreign = new Bridge({ token: "identity-collision-foreign-token", port: 0 });
  port = await foreign.start();
  config = { token: "identity-collision-other-token", port, timeoutMs: 3000 };
});

after(async () => {
  await foreign?.stop();
});

describe("foreign bridge on the configured port", () => {

  it("non-persistent acquire fails closed with an actionable message", async () => {
    await assert.rejects(acquireBridge(config, silentLogger), (error: Error) => {
      assert.ok(/Port \d+ already serves an Elf bridge with different credentials/.test(error.message));
      assert.ok(error.message.includes("ELF_MCP_PORT") && error.message.includes("ELF_MCP_TOKEN"));
      assert.ok(!error.message.includes("identity-collision"));
      return true;
    });
  });

  it("shared-host acquire fails closed with the same message", async () => {
    await assert.rejects(acquireBridge({ ...config, persistent: true }, silentLogger), (error: Error) => {
      assert.ok(/Port \d+ already serves an Elf bridge with different credentials/.test(error.message));
      assert.ok(!error.message.includes("identity-collision"));
      return true;
    });
  });
});
