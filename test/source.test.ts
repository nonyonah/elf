import assert from "node:assert/strict";
import { test } from "node:test";
import type { BridgeCaller } from "../src/figma/bridge.js";
import type { FigmaApi } from "../src/figma/client.js";
import { fetchFigmaTokens, isPlanOrPermissionError } from "../src/figma/source.js";
import type { DriftConfig } from "../src/types.js";

const PLAN_ERROR =
  "Figma API returned 403 for /files/abc/variables/local: {\"error\":\"Variables API requires an Enterprise plan\"}";
const MISSING_TOKEN = "Figma API token not found. Set the FIGMA_API_TOKEN environment variable.";

function config(source: DriftConfig["figma"]["source"]): DriftConfig {
  return {
    figma: { fileKey: "abc", apiTokenEnv: "FIGMA_API_TOKEN", source },
    codebase: { path: ".", source: "auto" },
    modeName: null,
    modeStrategy: "modes",
    nameMapping: {},
    deprecations: [],
  };
}

const restVariables = {
  meta: {
    variableCollections: {
      C1: { id: "C1", name: "Primitives", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Value" }] },
    },
    variables: {
      V1: {
        id: "V1",
        name: "color/primary",
        key: "k1",
        variableCollectionId: "C1",
        resolvedType: "COLOR",
        valuesByMode: { m1: { type: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } } },
      },
    },
  },
};

function restApi(error?: string): FigmaApi & { paths: string[] } {
  const paths: string[] = [];
  return {
    paths,
    get: async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (error) throw new Error(error);
      if (path.endsWith("/variables/local")) return restVariables as T;
      throw new Error(`unexpected REST path ${path}`);
    },
  };
}

function bridgeClient(): BridgeCaller & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    call: async <T>(method: string): Promise<T> => {
      calls.push(method);
      if (method === "list_collections") {
        return {
          collections: [
            { id: "C1", name: "Primitives", defaultModeId: "m1", modes: [{ modeId: "m1", name: "Value" }] },
          ],
        } as T;
      }
      if (method === "list_variables") {
        return {
          variables: [
            {
              id: "V1",
              name: "color/primary",
              collectionId: "C1",
              collectionName: "Primitives",
              resolvedType: "COLOR",
              valuesByMode: { Value: { type: "COLOR", value: "#ff0000" } },
            },
          ],
        } as T;
      }
      throw new Error(`unexpected bridge method ${method}`);
    },
    close: () => undefined,
  };
}

test("auto uses the REST API when it works and never touches the bridge", async () => {
  const api = restApi();
  const bridge = bridgeClient();
  const result = await fetchFigmaTokens(config("auto"), () => api, async () => bridge);

  assert.equal(result.source, "variables");
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0]?.value, "#ff0000");
  assert.deepEqual(bridge.calls, []);
});

test("auto falls back to the bridge on a plan error, from either transport", async () => {
  const bridge = bridgeClient();
  const result = await fetchFigmaTokens(config("auto"), () => restApi(PLAN_ERROR), async () => bridge);

  assert.equal(result.source, "variables (bridge)");
  assert.equal(result.tokens[0]?.value, "#ff0000");
  assert.deepEqual(bridge.calls, ["list_collections", "list_variables"]);
});

test("auto falls back to the bridge when no REST token is configured at all", async () => {
  const bridge = bridgeClient();
  const result = await fetchFigmaTokens(config("auto"), () => restApi(MISSING_TOKEN), async () => bridge);
  assert.equal(result.source, "variables (bridge)");
});

test("auto rethrows REST errors that are not about plans or permissions", async () => {
  await assert.rejects(
    fetchFigmaTokens(config("auto"), () => restApi("Figma API returned 404 for /files/abc/variables/local: nope"), async () => bridgeClient()),
    /404/,
  );
});

test("explicit variables source never falls back, even on a plan error", async () => {
  await assert.rejects(
    fetchFigmaTokens(config("variables"), () => restApi(PLAN_ERROR), async () => bridgeClient()),
    /Enterprise plan/,
  );
});

test("bridge source goes straight to the plugin", async () => {
  const api = restApi();
  const bridge = bridgeClient();
  const result = await fetchFigmaTokens(config("bridge"), () => api, async () => bridge);

  assert.equal(result.source, "variables (bridge)");
  assert.deepEqual(api.paths, [], "the REST API is not consulted");
  assert.deepEqual(bridge.calls, ["list_collections", "list_variables"]);
});

test("isPlanOrPermissionError tells plan errors apart from other failures", () => {
  assert.equal(isPlanOrPermissionError(new Error(PLAN_ERROR)), true);
  assert.equal(isPlanOrPermissionError(new Error("Figma API returned 402 for /x: upgrade required")), true);
  assert.equal(isPlanOrPermissionError(new Error("Figma API returned 400 for /x: endpoint not entitled")), true);
  assert.equal(isPlanOrPermissionError(new Error("Figma API returned 400 for /x: bad request")), false);
  assert.equal(isPlanOrPermissionError(new Error("Figma API returned 404 for /x")), false);
  assert.equal(isPlanOrPermissionError(new Error("fetch failed")), false);
});
