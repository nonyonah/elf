import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sha256Hex } from "../src/core/hash.js";

test("sha256Hex matches node:crypto across sizes and encodings", () => {
  const samples = [
    "",
    "abc",
    "hello world",
    "Design token drift: 1 item (file abc123)",
    "ünïcode 🔐 — em dash –",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "a".repeat(1000),
    Array.from({ length: 300 }, (_, i) => `line ${i}\u0000value ${i}`).join("\n"),
  ];
  for (const sample of samples) {
    const expected = createHash("sha256").update(sample).digest("hex");
    assert.equal(sha256Hex(sample), expected, `scan mismatch for ${sample.length} byte(s)`);
  }
});
