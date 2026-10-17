import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureWorkspace, findWorkspaceForUser } from "../src/db/workspaces";

describe("workspace helper", () => {
  it("creates a workspace plus ownership on first call and is idempotent after", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const first = await ensureWorkspace(env.DB, userId, "Ada's workspace");
    const second = await ensureWorkspace(env.DB, userId, "Ada's workspace");

    expect(second).toEqual(first);
    expect(first.name).toBe("Ada's workspace");

    const rows = await env.DB.prepare("SELECT role FROM members WHERE userId = ?")
      .bind(userId)
      .all<{ role: string }>();
    expect(rows.results).toEqual([{ role: "owner" }]);
  });

  it("keeps users in separate workspaces (tenant root)", async () => {
    const first = await ensureWorkspace(env.DB, `user-${crypto.randomUUID()}`, "A");
    const second = await ensureWorkspace(env.DB, `user-${crypto.randomUUID()}`, "B");
    expect(first.id).not.toBe(second.id);
  });

  it("falls back to a default name and finds nothing for unknown users", async () => {
    const workspace = await ensureWorkspace(env.DB, `user-${crypto.randomUUID()}`, "   ");
    expect(workspace.name).toBe("Workspace");
    await expect(findWorkspaceForUser(env.DB, "nobody")).resolves.toBeNull();
  });
});
