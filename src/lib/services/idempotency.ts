import { nowIso, type DB } from '../db';

/**
 * Durable replay guard.
 *
 * This used to be a `Map` in process memory, which meant a deploy or a restart
 * silently re-armed every key — so an offline Card Show queue replayed after a
 * restart double-counted cards — and it could not work at all with more than
 * one instance. The primary key does the work now: a repeated key hits the
 * conflict and is reported as a duplicate.
 */

const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Returns true when this key is new (caller should proceed). */
export function claimKey(db: DB, userId: string, key: string): boolean {
  const result = db
    .prepare('INSERT OR IGNORE INTO idempotency_keys (user_id, key, created_at) VALUES (?, ?, ?)')
    .run(userId, key, nowIso());
  return result.changes > 0;
}

/**
 * Drops keys older than the retention window.
 *
 * Sampled rather than run on every request: the sweep is a range delete, and
 * doing it per call turned a bounded cost into a per-request one.
 */
export function sweepKeys(db: DB, sampleRate = 0.02): void {
  if (Math.random() > sampleRate) return;
  db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(
    new Date(Date.now() - RETENTION_MS).toISOString(),
  );
}
