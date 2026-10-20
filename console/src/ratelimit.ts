/**
 * Fixed-window rate limiting: 60 requests / minute / token (CONTRACT.md §1).
 * D1-backed so every isolate and the scheduled jobs see the same counter.
 */
export const RATE_LIMIT_PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

export interface RateLimitVerdict {
  allowed: boolean;
  retryAfterSeconds: number;
}

export async function takeRateLimit(
  db: D1Database,
  scope: string,
  limit = RATE_LIMIT_PER_MINUTE,
): Promise<RateLimitVerdict> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % WINDOW_SECONDS);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (scope, windowStart, count) VALUES (?, ?, 1)
       ON CONFLICT(scope) DO UPDATE SET
         count = CASE WHEN rate_limits.windowStart = excluded.windowStart
                      THEN rate_limits.count + 1 ELSE 1 END,
         windowStart = excluded.windowStart
       RETURNING count`,
    )
    .bind(scope, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  if (count <= limit) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: windowStart + WINDOW_SECONDS - nowSeconds };
}
