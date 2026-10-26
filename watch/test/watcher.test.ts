import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSummary, startWatch } from "../src/watcher.js";
import type { CheckResult } from "../src/types.js";
import { FakeBridge, scratchProject, waitFor, writeSidecar } from "./helpers.js";

const clean = async (): Promise<CheckResult> => ({ status: "clean" });

test("summary is one compact line with failures and Slack status", () => {
  assert.equal(
    formatSummary(
      {
        components: 0,
        tokens: 0,
        styles: 0,
        conflicts: [],
        skipped: [],
        failed: ["Card"],
        failures: [{ name: "Card", error: "missing Badge" }],
      },
      { status: "drift", total: 3, notified: true },
      true,
    ),
    "no changes; 1 failed. drift: 3 items (Slack sent).",
  );
});

test("watcher debounces a burst into one sync", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  let checks = 0;
  const controller = startWatch({
    config: { batch: scratch.config, checkConfigPath: null, reportDir: scratch.dir },
    bridgeFactory: async () => bridge,
    runCheck: async () => {
      checks += 1;
      return clean();
    },
    debounceMs: 250,
    retryMs: 50,
    log: () => {},
  });

  try {
    await controller.ready;
    writeSidecar(scratch, "Button", {
      gap: "space.2",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    await waitFor(() => checks >= 1, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(checks, 1);
    assert.equal(bridge.componentNames("upsert_component").filter((name) => name === "Button").length, 1);
  } finally {
    await controller.close();
    scratch.cleanup();
  }
});

test("watcher queues while the bridge is down and retries", async () => {
  const scratch = scratchProject();
  const bridge = new FakeBridge();
  const logs: string[] = [];
  let attempts = 0;
  const controller = startWatch({
    config: { batch: scratch.config, checkConfigPath: null, reportDir: scratch.dir },
    bridgeFactory: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("No Figma plugin connected — open the plugin.");
      return bridge;
    },
    runCheck: clean,
    debounceMs: 50,
    retryMs: 40,
    log: (line) => logs.push(line),
  });

  try {
    await controller.ready;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    await waitFor(() => bridge.callsTo("upsert_component").length >= 2, 3_000);
    assert.ok(logs.some((line) => line.includes("Figma isn't connected")));
    assert.ok(attempts >= 2);
  } finally {
    await controller.close();
    scratch.cleanup();
  }
});

test("a bridge drop during components queues and retries the chunk", async () => {
  const scratch = scratchProject();
  const healthy = new FakeBridge();
  const logs: string[] = [];
  let factories = 0;
  let componentCalls = 0;
  const flaky = {
    async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (method === "upsert_component" && componentCalls++ === 0) {
        throw new Error("No Figma plugin connected — open the plugin.");
      }
      return healthy.call<T>(method, params);
    },
  };
  const controller = startWatch({
    config: { batch: scratch.config, checkConfigPath: null, reportDir: scratch.dir },
    bridgeFactory: async () => (++factories === 1 ? flaky : healthy),
    runCheck: clean,
    debounceMs: 50,
    retryMs: 40,
    log: (line) => logs.push(line),
  });

  try {
    await controller.ready;
    writeSidecar(scratch, "Button", {
      gap: "space.4",
      padding: { all: "space.4" },
      fill: "color.primary.500",
      children: [{ type: "instance", component: "Icon.tsx#Icon" }],
    });

    await waitFor(() => healthy.callsTo("upsert_component").length >= 2, 3_000);
    assert.ok(logs.some((line) => line.includes("Figma isn't connected")));
    assert.ok(factories >= 2);
  } finally {
    await controller.close();
    scratch.cleanup();
  }
});
