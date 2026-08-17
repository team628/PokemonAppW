/**
 * Worker-thread entry point for the want-index refresh.
 *
 * better-sqlite3 is synchronous, so a multi-second aggregate on the main thread
 * stalls every request on the server — that is what made the public partner
 * console a denial-of-service vector. Running the refresh on its own thread
 * keeps the event loop free; SQLite's WAL mode lets it write while readers
 * continue uninterrupted.
 */
import { workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const { dbPath, schemaPath } = workerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 30000');
db.exec(readFileSync(schemaPath, 'utf8'));

const started = Date.now();

const rows = db
  .prepare(
    `SELECT v.card_id, v.variant, COUNT(DISTINCT g.user_id) AS collectors,
            COALESCE(p.market_cents, p.mid_cents, p.low_cents) AS market_cents
     FROM set_goals g
     JOIN cards c ON c.set_id = g.set_id
     JOIN card_variants v ON v.card_id = c.id
     LEFT JOIN prices p
            ON p.card_id = v.card_id AND p.variant = v.variant AND p.provider = 'tcgplayer'
     WHERE (
             g.mode = 'master'
             OR (v.is_primary = 1 AND (g.mode = 'complete' OR c.is_secret = 0))
           )
       AND NOT EXISTS (
             SELECT 1 FROM collection_items ci
             WHERE ci.user_id = g.user_id AND ci.card_id = v.card_id
               AND ci.variant = v.variant AND ci.quantity > 0
           )
     GROUP BY v.card_id, v.variant`,
  )
  .all();

let totalDemand = 0;
let demandValue = 0;
for (const r of rows) {
  totalDemand += r.collectors;
  demandValue += r.collectors * (r.market_cents ?? 0);
}

const insert = db.prepare(
  'INSERT OR REPLACE INTO want_index (card_id, variant, collectors, market_cents) VALUES (?, ?, ?, ?)',
);

db.transaction(() => {
  db.prepare('DELETE FROM want_index').run();
  for (const r of rows) insert.run(r.card_id, r.variant, r.collectors, r.market_cents);
  db.prepare(
    `INSERT OR REPLACE INTO want_index_meta
       (id, computed_at, duration_ms, open_wants, total_demand, demand_value_cents)
     VALUES (1, ?, ?, ?, ?, ?)`,
  ).run(new Date().toISOString(), Date.now() - started, rows.length, totalDemand, demandValue);
})();

db.close();
parentPort?.postMessage({ openWants: rows.length, durationMs: Date.now() - started });
