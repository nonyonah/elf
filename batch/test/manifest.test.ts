import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { hashSpec, loadManifest, saveManifest, stableStringify } from "../src/manifest.js";
import { nodeStateHash } from "../src/nodestate.js";

describe("manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "elf-manifest-"));
  const path = join(dir, "elf.manifest.json");
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing file loads as an empty version-1 manifest", () => {
    assert.deepEqual(loadManifest(path), { version: 1, components: {}, tokens: {} });
  });

  test("saves atomically with sorted keys and canonical field order", () => {
    saveManifest(path, {
      version: 1,
      components: {
        "Z.tsx#Z": { figmaNodeId: "1:2", specHash: "bbb", status: "synced", updatedAt: "t", error: "kept" },
        "A.tsx#A": { figmaNodeId: "1:1", specHash: "aaa", status: "failed", updatedAt: "t" },
      },
      tokens: {
        "space.4": { figmaVariableId: "V:2", valueHash: "h2" },
        "color.x": { figmaVariableId: "V:1", valueHash: "h1" },
      },
    });

    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed.components), ["A.tsx#A", "Z.tsx#Z"]);
    assert.deepEqual(Object.keys(parsed.tokens), ["color.x", "space.4"]);
    assert.deepEqual(Object.keys(parsed.components["Z.tsx#Z"]), [
      "figmaNodeId",
      "specHash",
      "status",
      "updatedAt",
      "error",
    ]);
    assert.ok(raw.endsWith("\n"));
    assert.throws(() => readFileSync(`${path}.tmp`), "the tmp file must be gone after the rename");

    const first = raw;
    saveManifest(path, loadManifest(path));
    assert.equal(readFileSync(path, "utf8"), first, "a re-save of the same manifest is byte-identical");
  });

  test("a broken manifest is an error, never silently ignored", () => {
    writeFileSync(path, "{ not json");
    assert.throws(() => loadManifest(path), /not valid JSON/);
    writeFileSync(path, JSON.stringify({ version: 2, components: {}, tokens: {} }));
    assert.throws(() => loadManifest(path), /version 2/);
  });

  test("hashSpec ignores key order but notices values", () => {
    assert.equal(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
    assert.equal(hashSpec({ a: 1, b: { c: 2 } }), hashSpec({ b: { c: 2 }, a: 1 }));
    assert.notEqual(hashSpec({ a: 1 }), hashSpec({ a: 2 }));
    assert.equal(hashSpec({ a: 1 }).length, 16);
  });

  test("nodeHash sits between specHash and status, and survives a re-save", () => {
    saveManifest(path, {
      version: 1,
      components: {
        "A.tsx#A": {
          figmaNodeId: "1:1",
          specHash: "aaa",
          nodeHash: "cafe0123cafe0123",
          status: "synced",
          updatedAt: "t",
        },
      },
      tokens: {},
    });

    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(parsed.components["A.tsx#A"]), [
      "figmaNodeId",
      "specHash",
      "nodeHash",
      "status",
      "updatedAt",
    ]);
    assert.equal(parsed.components["A.tsx#A"].nodeHash, "cafe0123cafe0123");

    saveManifest(path, loadManifest(path));
    assert.equal(JSON.parse(readFileSync(path, "utf8")).components["A.tsx#A"].nodeHash, "cafe0123cafe0123");
  });

  test("nodeStateHash ignores on-canvas position but notices real changes", () => {
    const node = {
      id: "1:1",
      name: "Button",
      type: "COMPONENT",
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      children: [{ id: "1:2", name: "Icon", x: 1, y: 2, width: 8, height: 8 }],
    };

    const moved = { ...node, x: 999, y: -5, children: [{ ...node.children[0], x: 50, y: 60 }] };
    assert.equal(nodeStateHash(moved), nodeStateHash(node), "dragging is not drift");

    const resized = { ...node, width: 120 };
    assert.notEqual(nodeStateHash(resized), nodeStateHash(node), "resizing is drift");

    const renamedChild = { ...node, children: [{ ...node.children[0], name: "Glyph" }] };
    assert.notEqual(nodeStateHash(renamedChild), nodeStateHash(node), "children are part of the state");
  });
});
