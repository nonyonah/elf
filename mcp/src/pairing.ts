import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 12;
const SESSION_VERSION = "elf1";

export interface PairingCode {
  /** Human-readable, grouped as `abcd-efgh-jkmn`. Never persist this. */
  code: string;
  expiresAt: number;
}

export interface SessionSecret {
  session: string;
  expiresAt: number;
}

/** Groups a normalized code as 4-4-4 for display. */
export function formatPairingCode(raw: string): string {
  return normalizePairingCode(raw).replace(/(.{4})(?=.)/g, "$1-");
}

/** Lowercase, strips separators — so pasted codes are forgiving. */
export function normalizePairingCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createPairingCode(now = Date.now(), ttlMs = PAIRING_CODE_TTL_MS): PairingCode {
  let raw = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return { code: formatPairingCode(raw), expiresAt: now + ttlMs };
}

/** Hash of the normalized code; the raw code is only ever shown once. */
export function pairingCodeDigest(code: string): Buffer {
  return createHash("sha256").update(normalizePairingCode(code)).digest();
}

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Stateless session secrets, signed with the bridge token. They survive a
 * server restart (so the plugin only pairs once per Figma file) without
 * writing secrets to disk. Rotating ELF_MCP_TOKEN invalidates every session.
 */
export function issueSession(
  key: string,
  now = Date.now(),
  ttlMs = SESSION_TTL_MS,
): SessionSecret {
  const expiresAt = now + ttlMs;
  const payload = `${SESSION_VERSION}.${expiresAt}.${randomBytes(18).toString("base64url")}`;
  return { session: `${payload}.${sign(key, payload)}`, expiresAt };
}

/** Returns the session expiry when valid, or null. */
export function verifySession(key: string, session: string, now = Date.now()): number | null {
  const parts = session.split(".");
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(sign(key, payload));
  const actual = Buffer.from(parts[3]);
  if (!safeEqual(expected, actual)) return null;
  return expiresAt;
}

function sign(key: string, payload: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}
