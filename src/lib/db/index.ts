import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Single process-wide SQLite handle.
 *
 * The rest of the app talks to this through the query helpers in `src/lib/*`
 * rather than reaching for raw SQL in request handlers, so moving to a hosted
 * Postgres later means reimplementing this module and the repositories, not the
 * domain logic.
 */

export type DB = Database.Database;

const DB_PATH = process.env.SETVALUE_DB ?? path.join(process.cwd(), 'data', 'setvalue.db');
const SCHEMA_PATH = path.join(process.cwd(), 'src', 'lib', 'db', 'schema.sql');

declare global {
  // eslint-disable-next-line no-var
  var __setvalue_db: DB | undefined;
}

/**
 * One-way data migrations.
 *
 * `schema.sql` is all CREATE ... IF NOT EXISTS, so it cannot change an existing
 * column default or repair existing rows. Anything that must alter data already
 * in the database goes here, runs once, and is recorded.
 */
const MIGRATIONS: { id: string; run: (db: DB) => void }[] = [
  {
    // Collections were public by default in the first release, and no setting
    // existed to change that. Everyone is returned to private; sharing is now
    // something a collector opts into.
    id: '001-collections-private-by-default',
    run: (db) => db.prepare('UPDATE users SET share_public = 0').run(),
  },
];

function migrate(db: DB): void {
  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.run(db);
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, nowIso());
    })();
  }
}

function open(): DB {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

export function getDb(): DB {
  if (!globalThis.__setvalue_db) globalThis.__setvalue_db = open();
  return globalThis.__setvalue_db;
}

/** Opens a fresh handle (used by ingest scripts and tests). */
export function openDb(file?: string): DB {
  const db = new Database(file ?? DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  migrate(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
