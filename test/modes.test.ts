import assert from "node:assert/strict";
import { test } from "node:test";
import type { FigmaApi } from "../src/figma/client.js";
import { fetchVariables } from "../src/figma/variables.js";
import type { Token } from "../src/types.js";

type Raw = Record<string, unknown>;

function fakeApi(payload: Raw): FigmaApi {
  return {
    get: async <T>(): Promise<T> => payload as T,
  };
}

const collections = {
  C1: {
    id: "C1",
    name: "Semantic",
    defaultModeId: "m1",
    modes: [
      { modeId: "m1", name: "Light" },
      { modeId: "m2", name: "Dark" },
    ],
  },
  C2: {
    id: "C2",
    name: "Primitives",
    defaultModeId: "m3",
    modes: [
      { modeId: "m3", name: "Light" },
      { modeId: "m4", name: "Dark" },
    ],
  },
};

const variables = {
  V1: {
    id: "V1",
    name: "color/bg",
    key: "k1",
    variableCollectionId: "C1",
    resolvedType: "COLOR",
    valuesByMode: {
      m1: { type: "COLOR", value: { r: 1, g: 1, b: 1 } },
      m2: { type: "COLOR", value: { r: 0, g: 0, b: 0 } },
    },
  },
  V2: {
    id: "V2",
    name: "color/bg-primary",
    key: "k2",
    variableCollectionId: "C2",
    resolvedType: "COLOR",
    valuesByMode: {
      m3: { type: "COLOR", value: { r: 0.1, g: 0.2, b: 0.3 } },
      m4: { type: "COLOR", value: { r: 0.4, g: 0.5, b: 0.6 } },
    },
  },
  V3: {
    id: "V3",
    name: "color/alias",
    key: "k3",
    variableCollectionId: "C1",
    resolvedType: "COLOR",
    valuesByMode: {
      m1: { type: "VARIABLE_ALIAS", value: "V2" },
      m2: { type: "VARIABLE_ALIAS", value: "V2" },
    },
  },
  V4: {
    id: "V4",
    name: "radius/lg",
    key: "k4",
    variableCollectionId: "C2",
    resolvedType: "FLOAT",
    valuesByMode: { m3: { type: "FLOAT", value: 24 } },
  },
  V5: {
    id: "V5",
    name: "shadow/harsh",
    key: "k5",
    variableCollectionId: "C2",
    resolvedType: "FLOAT",
    valuesByMode: { m3: { type: "FLOAT", value: 3 } },
  },
};

const api = fakeApi({ meta: { variableCollections: collections, variables } });

function byName(tokens: Token[]): Map<string, Token[]> {
  const map = new Map<string, Token[]>();
  for (const token of tokens) {
    const list = map.get(token.name) ?? [];
    list.push(token);
    map.set(token.name, list);
  }
  return map;
}

test('modeName "all" produces one labelled token per mode', async () => {
  const tokens = await fetchVariables(api, "file", { modeName: "all" });
  const grouped = byName(tokens);

  const bg = grouped.get("color-bg") ?? [];
  assert.deepEqual(
    bg.map((token) => [token.mode, token.value]).sort(),
    [
      ["Dark", "#000000"],
      ["Light", "#ffffff"],
    ],
  );
});

test("cross-collection aliases resolve by mode name", async () => {
  const tokens = await fetchVariables(api, "file", { modeName: "all" });
  const alive = (byName(tokens).get("color-alias") ?? []).map((token) => [token.mode, token.value]);

  assert.deepEqual(alive.sort(), [
    ["Dark", "#668099"],
    ["Light", "#1a334d"],
  ]);
});

test("the collections strategy labels each token with its collection", async () => {
  const tokens = await fetchVariables(api, "file", { modeName: "all", modeStrategy: "collections" });
  const labelled = tokens
    .filter((token) => token.name.startsWith("color-bg"))
    .map((token) => [token.name, token.mode]);

  assert.deepEqual(labelled.sort(), [
    ["color-bg", "Semantic"],
    ["color-bg-primary", "Primitives"],
  ]);
});

test("the collections strategy accepts a subset by collection name", async () => {
  const tokens = await fetchVariables(api, "file", { modeName: ["Primitives"], modeStrategy: "collections" });
  const names = new Set(tokens.map((token) => token.name));
  assert.equal(names.has("color-bg"), false, "Semantic was not requested");
  assert.equal(names.has("color-bg-primary"), true);
});

test("radius FLOATs become tokens; shadow FLOATs are skipped", async () => {
  const tokens = await fetchVariables(api, "file", {});
  const names = new Set(tokens.map((token) => token.name));

  const radius = tokens.find((token) => token.name === "radius-lg");
  assert.equal(radius?.category, "radius");
  assert.equal(radius?.value, "24px");
  assert.equal(names.has("shadow-harsh"), false);
});
