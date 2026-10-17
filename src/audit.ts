/**
 * Who did what — identifiers and actions only, never secrets. Best-effort:
 * an audit write failing must never fail the mutation it describes.
 */
export async function logAudit(
  db: D1Database,
  workspaceId: string,
  actor: string,
  action: string,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO audit_log (id, workspaceId, actor, action, detail, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        workspaceId,
        actor,
        action,
        detail === undefined ? null : JSON.stringify(detail),
        new Date().toISOString(),
      )
      .run();
  } catch {
    // Audit is a convenience trail, not a source of truth.
  }
}
