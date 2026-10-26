import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { lintFiles } from "../src/lint.js";
import { scratchProject } from "./helpers.js";

const RAW = `export function Raw() {
  return (
    <div
      style={{
        color: "#6366f1",
        background: "rgb(255 255 255)",
        borderColor: "hsl(239, 84%, 67%)",
        padding: "16px",
        gap: "0.5rem",
        margin: "0px",
      }}
    />
  );
}
`;

test("lint finds hex, rgb, hsl, px and rem values with nearest tokens", () => {
  const scratch = scratchProject();
  try {
    const file = join(scratch.config.componentsDir, "Raw.tsx");
    writeFileSync(file, RAW);

    const result = lintFiles([file], scratch.config);
    assert.equal(result.errors.length, 0);
    assert.equal(result.findings.length, 5, "0px is ignored");

    const byValue = new Map(result.findings.map((finding) => [finding.value, finding]));
    assert.equal(byValue.get("#6366f1")?.suggestion, "color.primary.500");
    assert.equal(byValue.get("rgb(255 255 255)")?.suggestion, "color.surface.base");
    assert.equal(byValue.get("hsl(239, 84%, 67%)")?.suggestion, "color.primary.500");
    assert.equal(byValue.get("16px")?.suggestion, "space.4");
    assert.equal(byValue.get("0.5rem")?.suggestion, "space.2");
    assert.equal(byValue.get("0.5rem")?.normalized, "8px");
  } finally {
    scratch.cleanup();
  }
});

test("lint --strict exits 2 when it finds a hardcoded value", async () => {
  const scratch = scratchProject();
  const originalWrite = process.stdout.write;
  try {
    const file = join(scratch.config.componentsDir, "Raw.tsx");
    writeFileSync(file, RAW);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    const code = await main(["lint", "--strict", "--config", scratch.config.configPath, file]);
    assert.equal(code, 2);
  } finally {
    process.stdout.write = originalWrite;
    scratch.cleanup();
  }
});
