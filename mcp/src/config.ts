import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  /** Signs plugin session secrets and guards /control + HTTP. Never logged. */
  token: string;
  port: number;
  timeoutMs: number;
  sessionStorePath?: string;
  persistent?: boolean;
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
 * message rather than silently falling back — a missing secret would leave
 * the bridge open to anything on the machine.
 */
export function loadBridgeConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const token = env[TOKEN_ENV]?.trim() ?? "";
  if (!token) {
    throw new Error(
      `Bridge secret not found. Set the ${TOKEN_ENV} environment variable ` +
        `(generate one with: openssl rand -hex 24). It signs plugin sessions and guards /control.`,
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `Bridge secret in ${TOKEN_ENV} is too short (${token.length} characters, minimum ${MIN_TOKEN_LENGTH}).`,
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
  if (!Number.isSafeInteger(value) || value < minimum || value > (name === TIMEOUT_ENV ? 2_147_483_647 : 65_535)) {
    throw new Error(`${name} must be an integer >= ${minimum} and <= ${name === TIMEOUT_ENV ? 2_147_483_647 : 65_535}.`);
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
/** Shared machine identity. Never store this credential in a project or npm cache. */
export function loadRuntimeBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  credentialDir = join(homedir(), ".elf"),
): BridgeConfig {
  // Explicit configuration remains authoritative, including invalid values.
  if (env[TOKEN_ENV] !== undefined) {
    const config = loadBridgeConfig(env);
    return { ...config, persistent: config.port !== 0, sessionStorePath: join(credentialDir, `sessions-${createHash("sha256").update(config.token).digest("hex")}.json`) };
  }
  mkdirSync(credentialDir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(credentialDir);
  if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.platform !== "win32" && ((directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()))) {
    throw new Error("Elf credential directory must be owned by you and accessible only to you.");
  }
  const path = join(credentialDir, "bridge-secret");
  // Exclusive creation prevents two simultaneous starters from replacing the identity.
  try {
    const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, generateToken(), "utf8"); }
    finally { closeSync(descriptor); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 48 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new Error("Elf bridge credential must be a private, owner-only regular file.");
    }
    const token = readFileSync(descriptor, "utf8");
    if (!/^[a-f0-9]{48}$/.test(token)) throw new Error("Elf bridge credential is invalid; refusing to replace the saved identity.");
    const config = loadBridgeConfig({ ...env, [TOKEN_ENV]: token });
    return { ...config, persistent: config.port !== 0, sessionStorePath: join(credentialDir, `sessions-${createHash("sha256").update(token).digest("hex")}.json`) };
  } finally { closeSync(descriptor); }
}
