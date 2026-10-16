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