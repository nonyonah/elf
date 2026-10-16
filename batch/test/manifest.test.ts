import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { hashSpec, loadManifest, saveManifest, stableStringify } from "../src/manifest.js";

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
});
