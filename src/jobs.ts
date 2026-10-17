/**
 * Deferred work without Cloudflare Queues: a jobs table scanned by the
 * once-a-minute cron (and kicked opportunistically after an ingest, so a
 * single push usually lands its drift run within seconds).
 *
 * Drift jobs are debounced: one pending drift job per project, its notBefore
 * pushed forward while pushes keep arriving — a burst within the debounce
 * window runs once.
 */
import { runDrift } from "./drift.js";

export const DRIFT_DEBOUNCE_MS = 10_000;
const MAX_ATTEMPTS = 3;

export interface JobRow {
  id: string;
  projectId: string;
  type: "drift" | "poll" | "notify";
  attempts: number;
}

/** Enqueue (or push back) the project's single pending drift job. */
export async function enqueueDriftJob(
  db: D1Database,
  projectId: string,
  delayMs: number = DRIFT_DEBOUNCE_MS,
  nowMs: number = Date.now(),
): Promise<void> {
  const notBefore = new Date(nowMs + delayMs).toISOString();
  const pending = await db
    .prepare("SELECT id FROM jobs WHERE projectId = ? AND type = 'drift' AND attempts = 0 LIMIT 1")
    .bind(projectId)
    .first<{ id: string }>();
  if (pending) {
    await db.prepare("UPDATE jobs SET notBefore = ? WHERE id = ?").bind(notBefore, pending.id).run();
    return;
  }
  await db
    .prepare("INSERT INTO jobs (id, projectId, type, notBefore, attempts, createdAt) VALUES (?, ?, 'drift', ?, 0, ?)")
    .bind(crypto.randomUUID(), projectId, notBefore, new Date(nowMs).toISOString())
    .run();
}

/**
 * Claim and run due jobs. Claiming is a delete — two runners (cron + ingest
 * kick) racing can never run the same job twice.
 */
export async function runDueJobs(db: D1Database, now: Date = new Date()): Promise<number> {
  const due = await db
    .prepare("SELECT id, projectId, type, attempts FROM jobs WHERE notBefore <= ? ORDER BY notBefore LIMIT 10")
    .bind(now.toISOString())
    .all<JobRow>();

  let processed = 0;
  for (const job of due.results) {
    const claim = await db.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    if (claim.meta.changes === 0) continue;

    if (job.type === "drift") {
      try {
        await runDrift(db, job.projectId, "job", now);
        processed += 1;
      } catch (error) {
        // runDrift records its own failures; reaching here means infrastructure.
        const attempts = job.attempts + 1;
        if (attempts < MAX_ATTEMPTS) {
          await db
            .prepare("INSERT INTO jobs (id, projectId, type, notBefore, attempts, lastError, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(
              crypto.randomUUID(),
              job.projectId,
              job.type,
              new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)).toISOString(),
              attempts,
              error instanceof Error ? error.message : String(error),
              now.toISOString(),
            )
            .run();
        }
      }
    }
  }
  return processed;
}

/** Post-response kick: wait out the debounce, then process whatever is due. */
export async function kickDeferredJobs(db: D1Database, delayMs: number = DRIFT_DEBOUNCE_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 15_000) + 250));
  await runDueJobs(db);
}
