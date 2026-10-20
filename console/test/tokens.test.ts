import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { createToken, generateToken, hashToken, issueToken, resolveToken, TOKEN_PREFIX } from "../src/db/tokens";

async function seedProject(): Promise<string> {
  const now = new Date().toISOString();
  const workspaceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)").bind(workspaceId, "W", now),
    env.DB.prepare("INSERT INTO projects (id, workspaceId, name, slug, createdAt) VALUES (?, ?, ?, ?, ?)").bind(
      projectId,
      workspaceId,
      "P",
      `slug-${projectId.slice(0, 8)}`,
      now,
    ),
  ]);
  return projectId;
}

describe("token issuing", () => {
  it("generates prefixed, high-entropy, distinct tokens", () => {
    const a = generateToken("push");
    const b = generateToken("push");

    expect(a.startsWith(TOKEN_PREFIX.push)).toBe(true);
    expect(generateToken("plugin").startsWith(TOKEN_PREFIX.plugin)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(40);
  });

  it("hashes with SHA-256 (known vector)", async () => {
    await expect(hashToken("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("issueToken keeps hash and last4 consistent with the plaintext", async () => {
    const issued = await issueToken("push");
    expect(issued.kind).toBe("push");
    expect(issued.last4).toBe(issued.token.slice(-4));
    await expect(hashToken(issued.token)).resolves.toBe(issued.hash);
  });

  it("createToken stores only the hash plus last4 and never the plaintext", async () => {
    const projectId = await seedProject();
    const issued = await createToken(env.DB, projectId, "plugin", "bridge plugin");

    const row = await env.DB.prepare("SELECT * FROM tokens WHERE projectId = ?")
      .bind(projectId)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(row!.hash).toBe(issued.hash);
    expect(row!.last4).toBe(issued.last4);
    expect(JSON.stringify(row)).not.toContain(issued.token);
  });
});

describe("token resolution", () => {
  let projectId: string;

  beforeEach(async () => {
    projectId = await seedProject();
  });

  it("resolves a live token to its project and touches lastUsedAt", async () => {
    const issued = await createToken(env.DB, projectId, "push");
    const resolved = await resolveToken(env.DB, issued.token);

    expect(resolved).toEqual({ tokenId: expect.any(String), projectId, kind: "push" });
    const row = await env.DB.prepare("SELECT lastUsedAt FROM tokens WHERE id = ?")
      .bind(resolved!.tokenId)
      .first<{ lastUsedAt: string | null }>();
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("returns null for unknown, malformed and revoked tokens", async () => {
    const issued = await createToken(env.DB, projectId, "push");
    await expect(resolveToken(env.DB, "elf_push_not-a-real-token")).resolves.toBeNull();
    await expect(resolveToken(env.DB, "")).resolves.toBeNull();

    await env.DB.prepare(
      `UPDATE tokens SET revokedAt = ? WHERE hash = ?`,
    ).bind(new Date().toISOString(), issued.hash).run();
    await expect(resolveToken(env.DB, issued.token)).resolves.toBeNull();
  });
});
