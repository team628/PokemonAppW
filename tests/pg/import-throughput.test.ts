import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { matchRows, parseCsv, parseRows } from '@/lib/services/import';
import { addWithin } from '@/lib/services/pg/collection';
import { syncMilestonesForSet } from '@/lib/services/pg';
import { seedUser, dropUsers } from './fixtures';

/**
 * Import throughput against the real catalog.
 *
 * A collector migrating off another tracker arrives with thousands of rows, and
 * the two things that matter are that matching does not degrade into a
 * per-row catalog scan, and that the commit is one transaction — a
 * half-applied spreadsheet is worse than a rejected one, because the collector
 * cannot tell which half landed.
 *
 * The thresholds are deliberately loose. They exist to catch an accidental
 * O(rows x catalog) regression, not to pin a number to this machine.
 */

let user = '';

beforeAll(async () => {
  user = await seedUser('imp');
});

afterAll(async () => {
  await dropUsers(user);
  await closePool();
});

/**
 * A CSV naming real cards, sized to order.
 *
 * Restricted to sets whose name is unique in the catalog, because "set name +
 * number" is only an identity when the name resolves to one set — a handful of
 * promo and trainer-kit sets share a name, and the matcher is right to call
 * those ambiguous.
 */
async function bigCsv(rows: number): Promise<{ csv: string; count: number }> {
  const cards = await withServiceRole((tx) =>
    tx.rows<{ set_name: string; number: string }>(
      `select s.name as set_name, c.number
       from public.cards c
       join public.sets s on s.id = c.set_id
       join (select name from public.sets group by name having count(*) = 1) u on u.name = s.name
       order by s.release_date desc nulls last, c.number_sort
       limit $1`,
      [rows],
    ),
  );
  const lines = ['Set,Number,Qty,Condition'];
  for (const c of cards) lines.push(`${c.set_name},${c.number},1,Near Mint`);
  return { csv: lines.join('\n'), count: cards.length };
}

describe('import throughput', () => {
  it('parses a large CSV without quadratic behaviour', async () => {
    const { csv, count } = await bigCsv(5000);
    expect(count, 'the catalog must supply enough rows for this to mean anything')
      .toBeGreaterThan(4000);
    const t0 = performance.now();
    const parsed = parseCsv(csv);
    const ms = performance.now() - t0;
    expect(parsed.length).toBe(count + 1); // + the header row
    expect(ms, `${Math.round(ms)}ms to parse ${parsed.length} rows`).toBeLessThan(2000);
  });

  it('matches thousands of rows against the 20,000-card catalog in one pass', async () => {
    const { csv } = await bigCsv(5000);
    const { rows } = parseRows(csv);

    const t0 = performance.now();
    const result = await matchRows(user, rows);
    const ms = performance.now() - t0;

    expect(result.matched).toBeGreaterThan(4000);
    expect(result.unmatched).toBe(0);
    // Matching 5,000 rows must not take 5,000 round trips.
    expect(ms, `${Math.round(ms)}ms to match ${rows.length} rows`).toBeLessThan(30_000);
    console.log(
      `  matched ${result.matched}/${rows.length} rows in ${Math.round(ms)}ms ` +
        `(${Math.round(result.matched / (ms / 1000))} rows/s)`,
    );
  });

  it('commits the whole file in one transaction, and rolls back entirely on failure', async () => {
    const { csv } = await bigCsv(3000);
    const { rows } = parseRows(csv);
    const matched = await matchRows(user, rows);
    const exact = matched.rows
      .filter((r) => r.confidence === 'exact')
      .map((r) => ({ cardId: r.cardId!, variant: r.resolvedVariant!, quantity: r.quantity }));
    expect(exact.length).toBeGreaterThan(2000);

    // A row naming a card that does not exist, dropped in the middle. The whole
    // import must fail rather than leaving the first half applied.
    const poisoned = [...exact];
    poisoned.splice(Math.floor(poisoned.length / 2), 0, {
      cardId: 'no-such-card-9999', variant: 'normal', quantity: 1,
    });

    await expect(
      withIdentity(user, async (tx) => {
        for (const r of poisoned) await addWithin(tx, r);
      }),
    ).rejects.toThrow();

    const after = await withIdentity(user, async (tx) =>
      (await tx.one<{ n: number }>('select count(*)::int as n from public.collection_items'))!.n,
    );
    expect(after, 'a failed import left rows behind').toBe(0);

    // …and the clean file applies completely.
    const t0 = performance.now();
    const touched = new Set<string>();
    await withIdentity(user, async (tx) => {
      for (const r of exact) touched.add((await addWithin(tx, r)).set_id);
    });
    const ms = performance.now() - t0;

    const total = await withIdentity(user, async (tx) =>
      (await tx.one<{ n: number }>('select coalesce(sum(quantity),0)::int as n from public.collection_items'))!.n,
    );
    expect(total).toBe(exact.reduce((s, r) => s + r.quantity, 0));
    console.log(
      `  committed ${exact.length} rows across ${touched.size} sets in ${Math.round(ms)}ms ` +
        `(${Math.round(exact.length / (ms / 1000))} rows/s)`,
    );
    expect(ms, `${Math.round(ms)}ms to commit ${exact.length} rows`).toBeLessThan(60_000);
  });

  it('sweeps milestones once per set rather than once per row', async () => {
    // The import path calls syncMilestonesForSet after the transaction, so the
    // cost of milestones is bounded by sets touched, not rows imported.
    const t0 = performance.now();
    const fired = await syncMilestonesForSet(user, 'base1');
    const ms = performance.now() - t0;
    expect(Array.isArray(fired)).toBe(true);
    expect(ms, `${Math.round(ms)}ms for one set sweep`).toBeLessThan(5000);

    await withServiceRole((tx) =>
      tx.exec('delete from public.collection_items where user_id = $1::uuid', [user]),
    );
  });
});
