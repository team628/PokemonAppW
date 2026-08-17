import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getDb } from '../db';

/**
 * Keeps the materialised want index reasonably fresh without ever blocking a
 * request.
 *
 * A caller asks whether the index is stale and, if so, kicks a refresh off on a
 * worker thread — then returns immediately with whatever snapshot exists.
 * Nobody waits. At most one refresh runs at a time.
 */

const STALE_AFTER_MS = 5 * 60_000;

declare global {
  // eslint-disable-next-line no-var
  var __setvalue_want_refresh: { running: boolean; lastStarted: number } | undefined;
}

function state() {
  globalThis.__setvalue_want_refresh ??= { running: false, lastStarted: 0 };
  return globalThis.__setvalue_want_refresh;
}

export function wantIndexAge(): { computedAt: string | null; ageMs: number | null } {
  const row = getDb()
    .prepare('SELECT computed_at FROM want_index_meta WHERE id = 1')
    .get() as { computed_at: string } | undefined;
  if (!row) return { computedAt: null, ageMs: null };
  return { computedAt: row.computed_at, ageMs: Date.now() - Date.parse(row.computed_at) };
}

/** Fire-and-forget. Safe to call on every request. */
export function ensureWantIndexFresh(): void {
  const s = state();
  if (s.running) return;
  // Guard against a crashed worker pinning the flag, and against restart storms.
  if (Date.now() - s.lastStarted < 30_000) return;

  const { ageMs } = wantIndexAge();
  if (ageMs !== null && ageMs < STALE_AFTER_MS) return;

  s.running = true;
  s.lastStarted = Date.now();

  try {
    const worker = new Worker(path.join(process.cwd(), 'src', 'lib', 'services', 'wantIndexWorker.mjs'), {
      workerData: {
        dbPath: process.env.SETVALUE_DB ?? path.join(process.cwd(), 'data', 'setvalue.db'),
        schemaPath: path.join(process.cwd(), 'src', 'lib', 'db', 'schema.sql'),
      },
    });
    const done = () => {
      s.running = false;
    };
    worker.once('message', done);
    worker.once('error', (err: unknown) => {
      console.error('[want-index] refresh failed:', err instanceof Error ? err.message : err);
      done();
    });
    worker.once('exit', done);
    worker.unref();
  } catch (err) {
    s.running = false;
    console.error('[want-index] could not start refresh worker:', (err as Error).message);
  }
}
