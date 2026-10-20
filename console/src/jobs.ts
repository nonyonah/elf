/**
 * Deferred work without Cloudflare Queues: a jobs table scanned by the
 * once-a-minute cron (and kicked opportunistically after an ingest, so a
 * single push usually lands its drift run within seconds).
 *
 * Drift jobs are debounced: one pending drift job per project, its notBefore
 * pushed forward while pushes keep arriving — a burst within the debounce
 * window runs once. A drift run that deserves a Slack message enqueues a
 * notify job carrying the built message (see notify.ts).
 */
import type { Env } from "./env.js";
import { runDrift, type DriftOutcome } from "./drift.js";
import { planDriftNotification, runNotifyJob, type NotifyPlan } from "./notify.js";

export const DRIFT_DEBOUNCE_MS = 10_000;
const MAX_ATTEMPTS = 3;

export interface JobRow {
  id: string;
  projectId: string;
  type: "drift" | "poll" | "notify";
  attempts: number;
  payload: string | null;
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
 * Enqueue (or replace) the project's single pending notify job. Replacing is
 * right: the newest message supersedes an undelivered older one.
 */
export async function enqueueNotifyJob(
  db: D1Database,
  projectId: string,
  plan: NotifyPlan,
  nowMs: number = Date.now(),
): Promise<void> {
  const payload = JSON.stringify(plan);
  const now = new Date(nowMs).toISOString();
  const pending = await db
    .prepare("SELECT id FROM jobs WHERE projectId = ? AND type = 'notify' AND attempts = 0 LIMIT 1")
    .bind(projectId)
    .first<{ id: string }>();
  if (pending) {
    await db.prepare("UPDATE jobs SET notBefore = ?, payload = ? WHERE id = ?").bind(now, payload, pending.id).run();
    return;
  }
  await db
    .prepare(
      "INSERT INTO jobs (id, projectId, type, notBefore, attempts, payload, createdAt) VALUES (?, ?, 'notify', ?, 0, ?, ?)",
    )
    .bind(crypto.randomUUID(), projectId, now, payload, now)
    .run();
}

/** Plan and enqueue a Slack notification for a finished drift run, if any. */
async function maybeNotify(env: Env, projectId: string, outcome: DriftOutcome, nowMs: number): Promise<void> {
  const plan = await planDriftNotification(env.DB, projectId, outcome, {
    ...(env.CONSOLE_ORIGIN ? { consoleOrigin: env.CONSOLE_ORIGIN } : {}),
  });
  if (plan) await enqueueNotifyJob(env.DB, projectId, plan, nowMs);
}

/**
 * Claim and run due jobs. Claiming is a delete — two runners (cron + ingest
 * kick) racing can never run the same job twice. Failures are retried with
 * backoff up to MAX_ATTEMPTS.
 */
export async function runDueJobs(env: Env, now: Date = new Date()): Promise<number> {
  const db = env.DB;
  const due = await db
    .prepare("SELECT id, projectId, type, attempts, payload FROM jobs WHERE notBefore <= ? ORDER BY notBefore LIMIT 10")
    .bind(now.toISOString())
    .all<JobRow>();

  let processed = 0;
  for (const job of due.results) {
    const claim = await db.prepare("DELETE FROM jobs WHERE id = ?").bind(job.id).run();
    if (claim.meta.changes === 0) continue;

    try {
      if (job.type === "drift") {
        const outcome = await runDrift(db, job.projectId, "job", now);
        try {
          await maybeNotify(env, job.projectId, outcome, now.getTime());
        } catch {
          // Notification planning is best-effort — never re-run the drift over it.
        }
      } else if (job.type === "notify") {
        await runNotifyJob(env, job);
      } else {
        continue;
      }
      processed += 1;
    } catch (error) {
      // runDrift records its own failures; reaching here means infrastructure
      // (or a webhook that refused the post) — retry with backoff.
      const attempts = job.attempts + 1;
      if (attempts < MAX_ATTEMPTS) {
        await db
          .prepare(
            "INSERT INTO jobs (id, projectId, type, notBefore, attempts, payload, lastError, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .bind(
            crypto.randomUUID(),
            job.projectId,
            job.type,
            new Date(now.getTime() + 30_000 * 2 ** (attempts - 1)).toISOString(),
            attempts,
            job.payload,
            error instanceof Error ? error.message : String(error),
            now.toISOString(),
          )
          .run();
      }
    }
  }
  return processed;
}

/** Post-response kick: wait out the debounce, then process whatever is due. */
export async function kickDeferredJobs(env: Env, delayMs: number = DRIFT_DEBOUNCE_MS): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 15_000) + 250));
  await runDueJobs(env);
}
