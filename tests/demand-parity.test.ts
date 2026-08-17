import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '@/lib/db';
import { createUser } from '@/lib/auth';
import { addToCollection } from '@/lib/services/collection';
import { addGoal, goalViews } from '@/lib/services/goals';
import { buildWantIndex, demandReport, demandForSpares } from '@/lib/services/demand';
import { refreshWantIndex } from '@/lib/services/wantIndexRefresh';
import type { GoalMode } from '@/lib/domain/goals';

/**
 * The want index was rewritten from a JavaScript walk over every user's goals
 * into a single SQL aggregate. That is only a safe optimisation if the SQL
 * expresses exactly the same rule as `requirementsForMode`.
 *
 * These tests compute the answer both ways — the aggregate, and the original
 * per-user engine — and assert they agree, so the two definitions cannot drift
 * apart silently.
 */

let dir: string;
let db: DB;

function seedCatalog(db: DB) {
  db.prepare(
    `INSERT INTO sets (id, name, series, printed_total, total, release_date)
     VALUES ('tst', 'Test Set', 'Testing', 3, 4, '2023/01/01')`,
  ).run();
  const cards = [
    ['tst-1', '1', 'Alpha', 'Common', 0],
    ['tst-2', '2', 'Beta', 'Common', 0],
    ['tst-3', '3', 'Gamma', 'Rare Holo', 0],
    ['tst-4', '4', 'Secret', 'Rare Secret', 1],
  ] as const;
  for (const [id, n, name, rarity, secret] of cards) {
    db.prepare(
      `INSERT INTO cards (id,set_id,number,number_sort,number_suffix,name,rarity,is_secret,subtypes,types,national_dex)
       VALUES (?,'tst',?,?,'',?,?,?,'[]','[]','[]')`,
    ).run(id, n, Number(n), name, rarity, secret);
  }
  const variants: [string, string, number][] = [
    ['tst-1', 'normal', 1], ['tst-1', 'reverseHolofoil', 0],
    ['tst-2', 'normal', 1], ['tst-2', 'reverseHolofoil', 0],
    ['tst-3', 'holofoil', 1],
    ['tst-4', 'holofoil', 1],
  ];
  for (const [c, v, p] of variants) {
    db.prepare(
      "INSERT INTO card_variants (card_id,variant,source,is_primary) VALUES (?,?,'market_data',?)",
    ).run(c, v, p);
  }
  for (const [c, v, cents] of [
    ['tst-1', 'normal', 100], ['tst-1', 'reverseHolofoil', 250],
    ['tst-2', 'normal', 200], ['tst-2', 'reverseHolofoil', 400],
    ['tst-3', 'holofoil', 5000], ['tst-4', 'holofoil', 20000],
  ] as const) {
    db.prepare(
      `INSERT INTO prices (card_id,variant,provider,currency,low_cents,mid_cents,market_cents,observed_on,fetched_at)
       VALUES (?,?,'tcgplayer','USD',?,?,?,'2026-08-17','2026-08-17T00:00:00Z')`,
    ).run(c, v, Math.round(cents * 0.8), cents, cents);
  }
}

/** The original definition: walk every user, use the domain engine. */
function wantIndexViaEngine(db: DB, excludeUserId?: string): Map<string, number> {
  const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
  const index = new Map<string, number>();
  for (const u of users) {
    if (u.id === excludeUserId) continue;
    const seen = new Set<string>();
    for (const view of goalViews(db, u.id)) {
      for (const m of view.metrics.missing) seen.add(`${m.cardId}::${m.variant}`);
    }
    for (const k of seen) index.set(k, (index.get(k) ?? 0) + 1);
  }
  return index;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'parity-'));
  db = openDb(path.join(dir, 'test.db'));
  seedCatalog(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic population covering every goal mode and partial ownership. */
function populate(userCount: number) {
  const modes: GoalMode[] = ['main', 'complete', 'master'];
  const slots = db.prepare('SELECT card_id, variant FROM card_variants').all() as {
    card_id: string;
    variant: string;
  }[];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < userCount; i++) {
    const u = createUser(db, {
      email: `p${i}@example.test`,
      password: 'password123',
      displayName: `P${i}`,
    });
    addGoal(db, u.id, 'tst', modes[i % modes.length]!);
    for (const s of slots) {
      if (rand() < 0.4) {
        addToCollection(db, u.id, { cardId: s.card_id, variant: s.variant as never });
      }
    }
  }
}

describe('want index parity', () => {
  it('matches the per-user engine exactly across all goal modes', () => {
    populate(12);
    const sql = buildWantIndex(db);
    const engine = wantIndexViaEngine(db);

    expect(sql.size).toBe(engine.size);
    for (const [k, entry] of sql) {
      expect(entry.collectors, `collectors for ${k}`).toBe(engine.get(k));
    }
    // Non-trivial: the fixture must actually produce wants, or this proves nothing.
    expect(sql.size).toBeGreaterThan(0);
  });

  it('matches when a collector is excluded', () => {
    populate(8);
    const me = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: string }).id;
    const sql = buildWantIndex(db, { excludeUserId: me });
    const engine = wantIndexViaEngine(db, me);

    expect(sql.size).toBe(engine.size);
    for (const [k, entry] of sql) expect(entry.collectors, k).toBe(engine.get(k));
  });

  it('never counts a secret rare for a main-set goal', () => {
    const u = createUser(db, { email: 'm@example.test', password: 'password123', displayName: 'M' });
    addGoal(db, u.id, 'tst', 'main');
    const sql = buildWantIndex(db);
    expect(sql.has('tst-4::holofoil')).toBe(false);
    expect(sql.has('tst-1::normal')).toBe(true);
    // main takes the primary printing only
    expect(sql.has('tst-1::reverseHolofoil')).toBe(false);
  });

  it('counts every printing for a master goal', () => {
    const u = createUser(db, { email: 'x@example.test', password: 'password123', displayName: 'X' });
    addGoal(db, u.id, 'tst', 'master');
    const sql = buildWantIndex(db);
    expect(sql.has('tst-1::reverseHolofoil')).toBe(true);
    expect(sql.has('tst-4::holofoil')).toBe(true);
  });

  it('counts secrets but not extra printings for a complete goal', () => {
    const u = createUser(db, { email: 'c@example.test', password: 'password123', displayName: 'C' });
    addGoal(db, u.id, 'tst', 'complete');
    const sql = buildWantIndex(db);
    expect(sql.has('tst-4::holofoil')).toBe(true);
    expect(sql.has('tst-1::reverseHolofoil')).toBe(false);
  });

  it('stops counting a printing the moment the collector owns it', () => {
    const u = createUser(db, { email: 'o@example.test', password: 'password123', displayName: 'O' });
    addGoal(db, u.id, 'tst', 'main');
    expect(buildWantIndex(db).get('tst-3::holofoil')?.collectors).toBe(1);
    addToCollection(db, u.id, { cardId: 'tst-3', variant: 'holofoil' });
    expect(buildWantIndex(db).has('tst-3::holofoil')).toBe(false);
  });

  it('reports demand totals consistent with the index once refreshed', () => {
    populate(10);
    const index = buildWantIndex(db);
    // demandReport reads the materialised snapshot; building it is what the
    // background worker does in production.
    refreshWantIndex(db);
    const report = demandReport(db, { limit: 200 });
    expect(report.openWants).toBe(index.size);
    expect(report.totalDemand).toBe([...index.values()].reduce((s, e) => s + e.collectors, 0));
    expect(report.computedAt).not.toBeNull();
  });

  it('serves an empty report rather than throwing before the first refresh', () => {
    populate(4);
    const report = demandReport(db, { limit: 10 });
    expect(report.rows).toEqual([]);
    expect(report.computedAt).toBeNull();
    expect(report.openWants).toBe(0);
  });

  it('materialised rows match the live aggregate exactly', () => {
    populate(9);
    refreshWantIndex(db);
    const live = buildWantIndex(db);
    const stored = db
      .prepare('SELECT card_id, variant, collectors FROM want_index')
      .all() as { card_id: string; variant: string; collectors: number }[];
    expect(stored.length).toBe(live.size);
    for (const r of stored) {
      expect(live.get(`${r.card_id}::${r.variant}`)?.collectors, r.card_id).toBe(r.collectors);
    }
  });

  it('counts spare demand the same way as the index', () => {
    populate(10);
    const me = createUser(db, { email: 'me@example.test', password: 'password123', displayName: 'Me' });
    addToCollection(db, me.id, { cardId: 'tst-3', variant: 'holofoil', quantity: 3 });

    const spare = demandForSpares(db, me.id).find((s) => s.cardId === 'tst-3')!;
    const engine = wantIndexViaEngine(db, me.id).get('tst-3::holofoil') ?? 0;
    expect(spare.wantedBy).toBe(engine);
  });
});
