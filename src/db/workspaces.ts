/**
 * Workspaces — the tenant root. Schema 1: one user belongs to exactly one
 * workspace, created automatically on first sign-in. Every other table hangs
 * off this, so the helper here and the UNIQUE index on members.userId are the
 * floor of tenant isolation.
 */
export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export async function findWorkspaceForUser(db: D1Database, userId: string): Promise<Workspace | null> {
  const row = await db
    .prepare(
      "SELECT w.id, w.name, w.createdAt FROM members m JOIN workspaces w ON w.id = m.workspaceId WHERE m.userId = ?",
    )
    .bind(userId)
    .first<Workspace>();
  return row ?? null;
}

/** Idempotent: concurrent first sign-ins race on the UNIQUE index, the loser re-reads. */
export async function ensureWorkspace(db: D1Database, userId: string, name: string): Promise<Workspace> {
  const existing = await findWorkspaceForUser(db, userId);
  if (existing) return existing;

  const workspace: Workspace = {
    id: crypto.randomUUID(),
    name: name.trim() || "Workspace",
    createdAt: new Date().toISOString(),
  };
  try {
    await db.batch([
      db
        .prepare("INSERT INTO workspaces (id, name, createdAt) VALUES (?, ?, ?)")
        .bind(workspace.id, workspace.name, workspace.createdAt),
      db
        .prepare("INSERT INTO members (id, userId, workspaceId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)")
        .bind(crypto.randomUUID(), userId, workspace.id, workspace.createdAt),
    ]);
    return workspace;
  } catch (error) {
    const raced = await findWorkspaceForUser(db, userId);
    if (raced) return raced;
    throw error;
  }
}
