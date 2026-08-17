/**
 * Builds a synthetic collector population for load testing.
 *
 * Deterministic, so before/after runs are comparable. Writes to a scratch
 * database copied from the real catalog — it never touches data/setvalue.db.
 *
 *   npx tsx tests/load/generate.ts <users> [dbPath]
 */
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDb, newId, nowIso } from '../../src/lib/db/index';
import { createUser } from '../../src/lib/auth';
import { addGoal } from '../../src/lib/services/goals';
import { setRequirements, primaryVariantMap } from '../../src/lib/repo/catalog';
import { requirementsForMode, type GoalMode } from '../../src/lib/domain/goals';

const N = Number(process.argv[2] ?? 1000);
const DB = process.argv[3] ?? '/tmp/setvalue-load.db';
const SOURCE = path.join(process.cwd(), 'data', 'setvalue.db');

for (const suffix of ['', '-wal', '-shm']) {
  if (existsSync(DB + suffix)) rmSync(DB + suffix);
}
copyFileSync(SOURCE, DB);

const db = openDb(DB);
db.prepare('DELETE FROM collection_items').run();
db.prepare('DELETE FROM set_goals').run();
db.prepare('DELETE FROM events').run();
db.prepare('DELETE FROM milestones').run();
db.prepare('DELETE FROM sessions').run();
db.prepare("DELETE FROM users WHERE email LIKE 'load%'").run();

const SETS: [string, GoalMode][] = [
  ['sv3pt5', 'master'], ['base1', 'main'], ['swsh7', 'main'], ['sv1', 'main'],
  ['xy12', 'main'], ['sm12', 'main'], ['swsh12pt5', 'main'], ['neo1', 'main'],
];

const reqs = new Map<string, ReturnType<typeof requirementsForMode>>();
for (const [s, m] of SETS) {
  reqs.set(`${s}:${m}`, requirementsForMode(setRequirements(db, s), m, primaryVariantMap(db, s)));
}

let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

const insItem = db.prepare(
  `INSERT OR IGNORE INTO collection_items
     (id,user_id,card_id,variant,condition,quantity,for_trade,created_at,updated_at)
   VALUES (?,?,?,?,'NM',?,?,?,?)`,
);

const t0 = Date.now();
db.transaction(() => {
  for (let i = 0; i < N; i++) {
    const u = createUser(db, {
      email: `load${i}@example.test`,
      password: 'password123',
      displayName: `Collector ${i}`,
    });
    const nGoals = 1 + Math.floor(rand() * 3);
    for (let g = 0; g < nGoals; g++) {
      const [setId, mode] = SETS[Math.floor(rand() * SETS.length)]!;
      addGoal(db, u.id, setId, mode);
      const list = reqs.get(`${setId}:${mode}`)!;
      const share = 0.2 + rand() * 0.7;
      const now = nowIso();
      for (const r of list) {
        if (rand() > share) continue;
        const qty = rand() < 0.15 ? 2 : 1;
        insItem.run(newId('item'), u.id, r.cardId, r.variant, qty, qty > 1 && rand() < 0.5 ? 1 : 0, now, now);
      }
    }
    if ((i + 1) % 500 === 0) {
      console.log(`  ${i + 1}/${N} users (${Math.round((Date.now() - t0) / 1000)}s)`);
    }
  }
})();

// A deliberately extreme collector: the "obsessive" case the product targets.
const whale = createUser(db, {
  email: 'whale@example.test',
  password: 'password123',
  displayName: 'Whale',
});
for (const [setId, mode] of SETS) addGoal(db, whale.id, setId, mode);
const slots = db.prepare('SELECT card_id, variant FROM card_variants LIMIT 15000').all() as {
  card_id: string;
  variant: string;
}[];
const now = nowIso();
db.transaction(() => {
  for (const s of slots) insItem.run(newId('item'), whale.id, s.card_id, s.variant, 1, 0, now, now);
})();

const count = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
console.log(`users=${count('users')} goals=${count('set_goals')} items=${count('collection_items')}`);
console.log(`db=${DB}`);
db.close();
