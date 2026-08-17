import { getDb, type DB } from './db';

/**
 * Fixed-window rate limiting, stored in the database.
 *
 * In-memory counters were the obvious choice and the wrong one: a restart hands
 * an attacker a fresh budget, and a second instance doubles every limit. One
 * indexed upsert per guarded request is cheap next to what it protects.
 */

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface LimitRule {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export const RULES = {
  /** Password attempts against a single account. */
  signIn: { limit: 10, windowSeconds: 300 },
  /** Account creation from one address. */
  signUp: { limit: 5, windowSeconds: 3600 },
  /** Bulk import — expensive, and nobody legitimately runs many in a row. */
  importCommit: { limit: 10, windowSeconds: 3600 },
  /** Anonymous traffic to the public partner console. */
  publicPage: { limit: 60, windowSeconds: 60 },
  /** General authenticated write traffic. */
  write: { limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, LimitRule>;

export function checkLimit(db: DB, bucket: string, rule: LimitRule): LimitResult {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % rule.windowSeconds);

  db.prepare(
    `INSERT INTO rate_limits (bucket, window_start, hits) VALUES (?, ?, 1)
     ON CONFLICT(bucket, window_start) DO UPDATE SET hits = hits + 1`,
  ).run(bucket, windowStart);

  const row = db
    .prepare('SELECT hits FROM rate_limits WHERE bucket = ? AND window_start = ?')
    .get(bucket, windowStart) as { hits: number };

  // Sampled cleanup keeps the table from growing without adding a delete to
  // every request.
  if (Math.random() < 0.01) {
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(now - 86_400);
  }

  const remaining = Math.max(0, rule.limit - row.hits);
  return {
    allowed: row.hits <= rule.limit,
    remaining,
    retryAfterSeconds: windowStart + rule.windowSeconds - now,
  };
}

/**
 * Client address for limiting purposes.
 *
 * Behind a proxy the socket address is the proxy, so the forwarded header is
 * used when present. That header is client-controlled, so this is a speed bump
 * against casual abuse rather than a defence against a determined attacker with
 * many addresses — real protection belongs at the edge.
 */
export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

export function limitOrThrow(bucket: string, rule: LimitRule): void {
  const result = checkLimit(getDb(), bucket, rule);
  if (!result.allowed) {
    throw new RateLimitError(
      `Too many attempts. Try again in ${result.retryAfterSeconds}s.`,
      result.retryAfterSeconds,
    );
  }
}

export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}
