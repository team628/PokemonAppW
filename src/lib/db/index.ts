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

function open(): DB {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
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
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
