import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateToken, loadBridgeConfig, loadDotEnvFile, tokenFingerprint } from "../src/config.js";
import { DEFAULT_PORT, DEFAULT_TIMEOUT_MS, TOKEN_ENV } from "../src/protocol.js";

test("loadBridgeConfig refuses to start without a token", () => {
  assert.throws(() => loadBridgeConfig({}), (error: Error) => {
    assert.match(error.message, new RegExp(TOKEN_ENV));
    assert.match(error.message, /openssl rand -hex 24/);
    return true;
  });
});

test("loadBridgeConfig rejects a token that is too short", () => {
  assert.throws(
    () => loadBridgeConfig({ [TOKEN_ENV]: "short" }),
    /too short \(5 characters, minimum 8\)/,
  );
});

test("loadBridgeConfig defaults the port and timeout", () => {
  const config = loadBridgeConfig({ [TOKEN_ENV]: "0123456789abcdef" });
  assert.equal(config.token, "0123456789abcdef");
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
});

test("loadBridgeConfig reads overrides and validates them", () => {
  const config = loadBridgeConfig({
    [TOKEN_ENV]: "0123456789abcdef",
    ELF_MCP_PORT: "9000",
    ELF_MCP_TIMEOUT_MS: "2500",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.timeoutMs, 2500);

  assert.throws(() => loadBridgeConfig({ [TOKEN_ENV]: "0123456789abcdef", ELF_MCP_PORT: "nope" }), /ELF_MCP_PORT/);
  assert.throws(() => loadBridgeConfig({ [TOKEN_ENV]: "0123456789abcdef", ELF_MCP_TIMEOUT_MS: "0" }), />= 1/);
});

test("tokenFingerprint is short, stable, and not the token", () => {
  const token = generateToken();
  const fingerprint = tokenFingerprint(token);

  assert.equal(fingerprint.length, 8);
  assert.match(fingerprint, /^[0-9a-f]{8}$/);
  assert.equal(tokenFingerprint(token), fingerprint);
  assert.notEqual(token, fingerprint);
  assert.ok(!token.includes(fingerprint.slice(0, 4)));
});

test("generateToken returns a fresh 48-char hex secret", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^[0-9a-f]{48}$/);
  assert.notEqual(a, b);
  assert.ok(loadBridgeConfig({ [TOKEN_ENV]: a }));
});

function writeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "elf-mcp-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, contents);
  return path;
}

test("loadDotEnvFile reads keys, values and skips comments", () => {
  const path = writeEnvFile(
    [
      "# a comment",
      "",
      `${TOKEN_ENV}=0123456789abcdef`,
      "ELF_MCP_PORT=9999",
      "QUOTED=\"with spaces\"",
      "SINGLE='also spaces'",
      `export EXPORTED=${TOKEN_ENV}-style`,
      "not a pair",
      "1INVALID=x",
    ].join("\r\n"),
  );

  const env: NodeJS.ProcessEnv = {};
  loadDotEnvFile(path, env);
  assert.equal(env[TOKEN_ENV], "0123456789abcdef");
  assert.equal(env.ELF_MCP_PORT, "9999");
  assert.equal(env.QUOTED, "with spaces");
  assert.equal(env.SINGLE, "also spaces");
  assert.equal(env.EXPORTED, `${TOKEN_ENV}-style`);
  assert.equal(env["not a pair"], undefined);
  assert.equal(env["1INVALID"], undefined);
});

test("loadDotEnvFile never overrides real environment variables", () => {
  const path = writeEnvFile(`${TOKEN_ENV}=from-file\n`);
  const env: NodeJS.ProcessEnv = { [TOKEN_ENV]: "from-shell" };
  loadDotEnvFile(path, env);
  assert.equal(env[TOKEN_ENV], "from-shell");
});

test("loadDotEnvFile stays quiet when the file is missing", () => {
  const env: NodeJS.ProcessEnv = {};
  loadDotEnvFile(join(tmpdir(), "definitely-not-here", ".env"), env);
  assert.deepEqual(env, {});
});
// Runtime identity is outside consumer projects and is never silently rotated.
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { loadRuntimeBridgeConfig } from "../src/config.js";

function credentials(): string {
  return join(mkdtempSync(join(tmpdir(), "elf-identity-")), "private");
}

test("runtime creates a private identity and reuses it across restarts", () => {
  const dir = credentials();
  const first = loadRuntimeBridgeConfig({}, dir);
  const second = loadRuntimeBridgeConfig({}, dir);
  assert.equal(first.token, second.token);
  assert.match(first.token, /^[a-f0-9]{48}$/);
  assert.equal(readFileSync(join(dir, "bridge-secret"), "utf8"), first.token);
  if (process.platform !== "win32") {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "bridge-secret")).mode & 0o777, 0o600);
  }
});

test("runtime honors explicit tokens without accessing credential storage", () => {
  assert.equal(loadRuntimeBridgeConfig({ ELF_MCP_TOKEN: "explicit-secret" }, "/unavailable/path").token, "explicit-secret");
  assert.throws(() => loadRuntimeBridgeConfig({ ELF_MCP_TOKEN: "" }, "/unavailable/path"), /secret not found/);
});

test("runtime refuses corrupt credentials without replacing them", () => {
  const dir = credentials();
  mkdirSync(dir, { mode: 0o700 });
  const path = join(dir, "bridge-secret");
  writeFileSync(path, "broken", { mode: 0o600 });
  assert.throws(() => loadRuntimeBridgeConfig({}, dir), /private, owner-only/);
  assert.equal(readFileSync(path, "utf8"), "broken");
});

test("runtime refuses symlinked credentials and credential directories", () => {
  const dir = credentials();
  loadRuntimeBridgeConfig({}, dir);
  const linkedDir = `${dir}-link`;
  symlinkSync(dir, linkedDir);
  assert.throws(() => loadRuntimeBridgeConfig({}, linkedDir), /credential directory/);
  const other = credentials();
  mkdirSync(other, { mode: 0o700 });
  symlinkSync(join(dir, "bridge-secret"), join(other, "bridge-secret"));
  assert.throws(() => loadRuntimeBridgeConfig({}, other));
});

test("runtime refuses credentials readable by other users", { skip: process.platform === "win32" }, () => {
  const dir = credentials();
  loadRuntimeBridgeConfig({}, dir);
  chmodSync(join(dir, "bridge-secret"), 0o644);
  assert.throws(() => loadRuntimeBridgeConfig({}, dir), /private, owner-only/);
});

test("bridge settings reject fractional ports and out-of-range values", () => {
  for (const port of ["1.5", "65536", "Infinity", "-1"]) {
    assert.throws(() => loadBridgeConfig({ ELF_MCP_TOKEN: "explicit-secret", ELF_MCP_PORT: port }), /must be an integer/);
  }
  assert.throws(() => loadBridgeConfig({ ELF_MCP_TOKEN: "explicit-secret", ELF_MCP_TIMEOUT_MS: "2147483648" }), /must be an integer/);
});
