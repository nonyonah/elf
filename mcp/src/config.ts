import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DEFAULT_HTTP_PORT,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  HTTP_PORT_ENV,
  PORT_ENV,
  TIMEOUT_ENV,
  TOKEN_ENV,
} from "./protocol.js";

export interface BridgeConfig {
  /** Shared secret required in the WebSocket handshake. Never logged. */
  token: string;
  port: number;
  timeoutMs: number;
}

export const MIN_TOKEN_LENGTH = 8;

/**
 * Loads `KEY=VALUE` pairs from a .env file into the environment, without
 * overriding variables that already exist — a real `ELF_MCP_TOKEN` in the
 * shell beats the file, and a missing file is not an error.
 */
export function loadDotEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    env[key] = value;
  }
}

/**
 * Reads bridge settings from the environment. Throws with an actionable
 * message rather than silently falling back — a missing token would leave the
 * bridge open to anything on the machine.
 */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const token = env[TOKEN_ENV]?.trim() ?? "";
  if (!token) {
    throw new Error(
      `Bridge token not found. Set the ${TOKEN_ENV} environment variable ` +
        `(generate one with: openssl rand -hex 24) and give the same value to the plugin.`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `Bridge token in ${TOKEN_ENV} is too short (${token.length} characters, minimum ${MIN_TOKEN_LENGTH}).`,
    );
  }

  return {
    token,
    port: readNumber(env, PORT_ENV, DEFAULT_PORT, 0),
    timeoutMs: readNumber(env, TIMEOUT_ENV, DEFAULT_TIMEOUT_MS, 1),
  };
}

export function loadHttpPort(env: NodeJS.ProcessEnv = process.env): number {
  return readNumber(env, HTTP_PORT_ENV, DEFAULT_HTTP_PORT, 0);
}

function readNumber(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be a number >= ${minimum} (got "${raw}").`);
  }
  return value;
}

export function generateToken(): string {
  return randomBytes(24).toString("hex");
}

/**
 * A short, non-reversible fingerprint so logs can say *which* token was used
 * without ever printing it.
 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}