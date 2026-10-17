/**
 * elf's pure core: normalization, classification, diffing, deprecations,
 * reports and the Slack/plain-text formatter. No Node built-ins, no
 * `process`, no `console`, no network — enforced by test/core-purity.test.ts —
 * so the same code runs in the CLI and in any other JavaScript runtime,
 * like the elf console worker.
 */
export * from "./types.js";
export * from "./normalize.js";
export * from "./diff.js";
export * from "./deprecations.js";
export * from "./report.js";
export * from "./notify.js";
export { sha256Hex } from "./hash.js";
