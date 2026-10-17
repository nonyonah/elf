/**
 * Access tokens, per the elf contract: `elf_push_…` / `elf_plugin_…`.
 * 32 random bytes, shown once; the server stores only a SHA-256 hash and the
 * last 4 characters. Verification is hash-lookup + kind check + revocation.
 */
export type TokenKind = "push" | "plugin";

export const TOKEN_PREFIX: Record<TokenKind, string> = {
  push: "elf_push_",
  plugin: "elf_plugin_",
};

const TOKEN_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateToken(kind: TokenKind): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return `${TOKEN_PREFIX[kind]}${base64url(bytes)}`;
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface IssuedToken {
  /** The full token — returned to the caller exactly once. */
  token: string;
  hash: string;
  last4: string;
  kind: TokenKind;
  /** Set by createToken: the row id the token landed under. */
  tokenId?: string;
}

export async function issueToken(kind: TokenKind): Promise<IssuedToken> {
  const token = generateToken(kind);
  return { token, hash: await hashToken(token), last4: token.slice(-4), kind };
}

/** Persist a new token for a project; returns the plaintext once for show-once UIs. */
export async function createToken(
  db: D1Database,
  projectId: string,
  kind: TokenKind,
  label?: string,
): Promise<IssuedToken> {
  const issued = await issueToken(kind);
  const tokenId = crypto.randomUUID();
  await db
    .prepare("INSERT INTO tokens (id, projectId, kind, hash, last4, label, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(tokenId, projectId, kind, issued.hash, issued.last4, label ?? null, new Date().toISOString())
    .run();
  return { ...issued, tokenId };
}

export interface ResolvedToken {
  tokenId: string;
  projectId: string;
  kind: TokenKind;
}

/**
 * Resolve a raw bearer token to its project. Revoked, unknown, wrong-kind and
 * malformed tokens all resolve to null — callers answer `401 unauthorized`
 * without telling anyone which it was. Touches `lastUsedAt` on success.
 */
export async function resolveToken(db: D1Database, raw: string): Promise<ResolvedToken | null> {
  if (!raw) return null;
  const hash = await hashToken(raw);
  const row = await db
    .prepare("SELECT id, projectId, kind, revokedAt FROM tokens WHERE hash = ?")
    .bind(hash)
    .first<{ id: string; projectId: string; kind: TokenKind; revokedAt: string | null }>();
  if (!row || row.revokedAt) return null;
  await db
    .prepare("UPDATE tokens SET lastUsedAt = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id)
    .run();
  return { tokenId: row.id, projectId: row.projectId, kind: row.kind };
}
