import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { addToCollection, removeFromCollection } from '@/lib/services/pg/collection';
import { addGoal, removeGoal, demandReport, rebuildWantIndex } from '@/lib/services/pg';
import { seedSet, seedUser, dropUsers, type Fixture } from './fixtures';

/**
 * Want-index correctness.
 *
 * The index is maintained incrementally by triggers — adding a goal, adding a
 * card, removing either — because a materialised view would need REFRESH, and
 * REFRESH takes an ACCESS EXCLUSIVE lock that would stall every collector on
 * the site. Incremental maintenance buys that at the cost of a new failure
 * mode: drift. So the central assertion here is that the live, trigger-built
 * index is byte-for-byte what a full recomputation produces, after a workload
 * of adds, removes and goal changes.
 *
 * `rebuild_want_index()` is the same reconciliation the nightly job runs. If
 * these ever disagree, the nightly job is papering over a trigger bug.
 */

let fx: Fixture;
let users: string[] = [];

beforeAll(async () => {
  fx = await seedSet();
  users = await Promise.all(
    Array.from({ length: 12 }, (_, i) => seedUser(`dem-${i}`)),
  );
});

afterAll(async () => {
  await dropUsers(...users);
  await fx.cleanup();
  await rebuildWantIndex();
  await closePool();
});

const card = (n: number) => `${fx.setId}-${n}`;

/** Every want row the index currently holds for this suite's set. */
async function liveIndex(): Promise<Map<string, number>> {
  const rows = await withServiceRole((tx) =>
    tx.rows<{ card_id: string; variant: string; collectors: number }>(
      'select card_id, variant, collectors from public.want_index where card_id like $1 and collectors > 0',
      [`${fx.setId}-%`],
    ),
  );
  return new Map(rows.map((r) => [`${r.card_id}::${r.variant}`, r.collectors]));
}

async function reset() {
  await withServiceRole(async (tx) => {
    await tx.exec('delete from public.collection_items where user_id = any($1::uuid[])', [users]);
    await tx.exec('delete from public.set_goals where user_id = any($1::uuid[])', [users]);
  });
}

/** Deterministic pseudo-random workload — same sequence every run. */
async function populate(userCount: number) {
  await reset();
  const modes = ['main', 'complete', 'master'] as const;
  const slots: [number, string][] = [
    [1, 'normal'], [1, 'reverseHolofoil'], [2, 'normal'],
    [2, 'reverseHolofoil'], [3, 'holofoil'], [4, 'holofoil'],
  ];
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < userCount; i++) {
    const u = users[i]!;
    await addGoal(u, fx.setId, modes[i % modes.length]!);
    for (const [n, v] of slots) {
      if (rand() < 0.4) await addToCollection(u, { cardId: card(n), variant: v as never });
    }
  }
}

describe('want index', () => {
  it('matches a full rebuild exactly across all goal modes', async () => {
    await populate(12);
    const incremental = await liveIndex();
    // Non-trivial: the fixture must actually produce wants, or this proves nothing.
    expect(incremental.size).toBeGreaterThan(0);

    await rebuildWantIndex();
    const rebuilt = await liveIndex();

    expect(rebuilt.size).toBe(incremental.size);
    for (const [k, n] of rebuilt) expect(incremental.get(k), k).toBe(n);
  });

  it('stays in step after removals as well as additions', async () => {
    await populate(8);
    // Churn: three collectors drop a card, two drop their goal entirely.
    for (const u of users.slice(0, 3)) {
      await removeFromCollection(u, { cardId: card(1), variant: 'normal', quantity: 99 });
    }
    for (const u of users.slice(3, 5)) {
      const goals = await withIdentity(u, (tx) =>
        tx.rows<{ id: string }>('select id from public.set_goals where set_id = $1', [fx.setId]),
      );
      for (const g of goals) await removeGoal(u, g.id);
    }

    const incremental = await liveIndex();
    await rebuildWantIndex();
    const rebuilt = await liveIndex();

    expect(rebuilt.size).toBe(incremental.size);
    for (const [k, n] of rebuilt) expect(incremental.get(k), k).toBe(n);
  });

  it('never counts a secret rare for a main-set goal', async () => {
    await reset();
    await addGoal(users[0]!, fx.setId, 'main');
    const idx = await liveIndex();
    expect(idx.has(`${card(4)}::holofoil`)).toBe(false);
    expect(idx.has(`${card(1)}::normal`)).toBe(true);
    // main takes the primary printing only
    expect(idx.has(`${card(1)}::reverseHolofoil`)).toBe(false);
  });

  it('counts every printing for a master goal', async () => {
    await reset();
    await addGoal(users[0]!, fx.setId, 'master');
    const idx = await liveIndex();
    expect(idx.has(`${card(1)}::reverseHolofoil`)).toBe(true);
    expect(idx.has(`${card(4)}::holofoil`)).toBe(true);
  });

  it('counts secrets but not extra printings for a complete goal', async () => {
    await reset();
    await addGoal(users[0]!, fx.setId, 'complete');
    const idx = await liveIndex();
    expect(idx.has(`${card(4)}::holofoil`)).toBe(true);
    expect(idx.has(`${card(1)}::reverseHolofoil`)).toBe(false);
  });

  it('stops counting a printing the moment the collector owns it', async () => {
    await reset();
    await addGoal(users[0]!, fx.setId, 'main');
    expect((await liveIndex()).get(`${card(3)}::holofoil`)).toBe(1);

    await addToCollection(users[0]!, { cardId: card(3), variant: 'holofoil' });
    expect((await liveIndex()).has(`${card(3)}::holofoil`)).toBe(false);

    // …and re-opens when the card leaves the collection again.
    await removeFromCollection(users[0]!, { cardId: card(3), variant: 'holofoil' });
    expect((await liveIndex()).get(`${card(3)}::holofoil`)).toBe(1);
  });

  it('reports demand consistent with the index', async () => {
    await populate(10);
    const idx = await liveIndex();
    const report = await demandReport(2000, fx.setId);

    expect(report.length).toBe(idx.size);
    for (const r of report) {
      expect(idx.get(`${r.card_id}::${r.variant}`), r.card_id).toBe(r.collectors);
    }
  });

  it('reports counts only — never a collector identity', async () => {
    await populate(6);
    const report = await demandReport(2000, fx.setId);
    const serialized = JSON.stringify(report);
    for (const u of users) expect(serialized).not.toContain(u);
    for (const r of report) {
      expect(Object.keys(r)).not.toContain('user_id');
    }
  });

  it('counts spare demand the same way as the index', async () => {
    await populate(10);
    const me = users[0]!;
    // My own wants must not be counted against my own spares.
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', quantity: 3 });

    const spares = await withIdentity(me, (tx) =>
      tx.rows<{ card_id: string; variant: string; wanted_by: number }>(
        'select * from public.my_spare_demand()',
      ),
    );
    const spare = spares.find((s) => s.card_id === card(3) && s.variant === 'holofoil')!;
    const idx = await liveIndex();
    expect(spare.wanted_by).toBe(idx.get(`${card(3)}::holofoil`) ?? 0);
  });
});
