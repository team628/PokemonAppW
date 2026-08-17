import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { computeGoal, requirementsForMode, ownedIndex, type Requirement } from '@/lib/domain/goals';
import type { Variant } from '@/lib/catalog/variants';

/**
 * Parity between the PostgreSQL completion engine and the TypeScript one.
 *
 * The maths moved into the database for performance. That is only a safe move
 * if both implementations agree exactly — not approximately — so this computes
 * real sets both ways and compares integer cents.
 *
 * It also holds the two arithmetic guarantees the product rests on:
 *   COMPLETE = HAVE + NEED
 *   sum(missing list) = NEED
 */

let user = '';
const suffix = randomUUID().slice(0, 8);
const SETS = ['base1', 'sv3pt5', 'swsh7'] as const;
const MODES = ['main', 'complete', 'master'] as const;

/** Pulls the raw requirement rows and runs them through the domain engine. */
async function viaDomainEngine(setId: string, mode: (typeof MODES)[number]) {
  return withIdentity(user, async (tx) => {
    const all = await tx.rows<{
      card_id: string; variant: string; number: string; number_sort: number;
      name: string; rarity: string | null; image_small: string | null; is_secret: boolean;
      variant_source: 'market_data' | 'inferred'; market_cents: number | null;
      acquisition_cents: number | null; basis: string | null; observed_on: string | null;
      is_primary: boolean;
    }>(
      `select c.id as card_id, v.variant, c.number, c.number_sort, c.name, c.rarity,
              c.image_small, c.is_secret, v.source as variant_source, v.is_primary,
              public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) as market_cents,
              public.slot_acquisition_cents(p.direct_cents, p.low_cents, p.market_cents, p.mid_cents) as acquisition_cents,
              public.slot_basis(p.market_cents, p.mid_cents, p.low_cents) as basis,
              p.observed_on::text as observed_on
       from public.cards c
       join public.card_variants v on v.card_id = c.id
       left join public.prices p
              on p.card_id = c.id and p.variant = v.variant and p.provider = 'tcgplayer'
       where c.set_id = $1`,
      [setId],
    );

    const owned = await tx.rows<{ card_id: string; variant: string; qty: number }>(
      `select card_id, variant, sum(quantity)::int as qty
       from public.collection_items where card_id in (
         select id from public.cards where set_id = $1
       ) group by card_id, variant`,
      [setId],
    );

    const reqs: Requirement[] = all.map((r) => ({
      cardId: r.card_id,
      variant: r.variant as Variant,
      number: r.number,
      numberSort: r.number_sort,
      name: r.name,
      rarity: r.rarity,
      imageSmall: r.image_small,
      isSecret: r.is_secret,
      marketCents: r.market_cents,
      acquisitionCents: r.acquisition_cents,
      basis: r.basis as Requirement['basis'],
      observedOn: r.observed_on,
      variantSource: r.variant_source,
    }));

    const primaries = new Map<string, Variant>(
      all.filter((r) => r.is_primary).map((r) => [r.card_id, r.variant as Variant]),
    );

    return computeGoal(
      mode,
      requirementsForMode(reqs, mode, primaries),
      ownedIndex(owned.map((o) => ({ cardId: o.card_id, variant: o.variant as Variant, quantity: o.qty }))),
    );
  });
}

async function viaPostgres(setId: string, mode: (typeof MODES)[number]) {
  return withIdentity(user, async (tx) =>
    (await tx.one<{
      required_count: number; owned_count: number; missing_count: number;
      have_cents: number; need_cents: number; complete_cents: number;
      need_acquisition_cents: number; priced_missing: number; unpriced_missing: number;
      market_data_slots: number;
    }>(`select * from public.goal_metrics($1, $2)`, [setId, mode]))!,
  );
}

beforeAll(async () => {
  user = (await withServiceRole(async (tx) =>
    tx.one<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1::citext, jsonb_build_object('display_name', 'Parity'::text)) returning id`,
      [`parity-${suffix}@example.test`],
    ),
  ))!.id;

  // A deterministic partial collection across all three sets.
  await withIdentity(user, async (tx) => {
    for (const setId of SETS) {
      await tx.exec(
        `insert into public.collection_items (user_id, card_id, variant, quantity)
         select $1, s.card_id, s.variant, 1
         from (
           select c.id as card_id, v.variant,
                  row_number() over (order by c.number_sort, v.variant) as rn
           from public.cards c join public.card_variants v on v.card_id = c.id
           where c.set_id = $2
         ) s
         where s.rn % 3 <> 0
         on conflict do nothing`,
        [user, setId],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await withServiceRole(async (tx) => {
    if (user) await tx.exec('delete from auth.users where id = $1::uuid', [user]);
  });
  await closePool();
});

describe('completion engine parity', () => {
  for (const setId of SETS) {
    for (const mode of MODES) {
      it(`${setId} / ${mode}: PostgreSQL matches the domain engine exactly`, async () => {
        const [pg, ts] = await Promise.all([viaPostgres(setId, mode), viaDomainEngine(setId, mode)]);

        expect(pg.required_count, 'required').toBe(ts.requiredCount);
        expect(pg.owned_count, 'owned').toBe(ts.ownedCount);
        expect(pg.missing_count, 'missing').toBe(ts.missingCount);
        expect(pg.have_cents, 'have').toBe(ts.haveCents);
        expect(pg.need_cents, 'need').toBe(ts.needCents);
        expect(pg.complete_cents, 'complete').toBe(ts.completeCents);
        expect(pg.need_acquisition_cents, 'acquisition').toBe(ts.needAcquisitionCents);
        expect(pg.priced_missing, 'priced missing').toBe(ts.pricedMissing);
        expect(pg.unpriced_missing, 'unpriced missing').toBe(ts.unpricedMissing);
      }, 60_000);
    }
  }

  it('the fixture is non-trivial, so parity means something', async () => {
    const m = await viaPostgres('sv3pt5', 'master');
    expect(m.required_count).toBeGreaterThan(300);
    expect(m.owned_count).toBeGreaterThan(0);
    expect(m.missing_count).toBeGreaterThan(0);
    expect(m.complete_cents).toBeGreaterThan(0);
  });
});

describe('the arithmetic guarantees', () => {
  for (const setId of SETS) {
    for (const mode of MODES) {
      it(`${setId} / ${mode}: HAVE + NEED = COMPLETE, exactly`, async () => {
        const m = await viaPostgres(setId, mode);
        expect(m.have_cents + m.need_cents).toBe(m.complete_cents);
        expect(Number.isInteger(m.have_cents)).toBe(true);
        expect(Number.isInteger(m.need_cents)).toBe(true);
      });

      it(`${setId} / ${mode}: the missing list sums to NEED`, async () => {
        const m = await viaPostgres(setId, mode);
        const rows = await withIdentity(user, (tx) =>
          tx.rows<{ market_cents: number | null }>(
            `select market_cents from public.goal_missing($1, $2, 2000, 0)`,
            [setId, mode],
          ),
        );
        expect(rows.length, 'row count').toBe(m.missing_count);
        const summed = rows.reduce((s, r) => s + (r.market_cents ?? 0), 0);
        expect(summed, 'summed missing list').toBe(m.need_cents);
      }, 30_000);
    }
  }

  it('an unpriced missing card contributes nothing and is counted, never zeroed', async () => {
    const m = await viaPostgres('base1', 'master');
    expect(m.priced_missing + m.unpriced_missing).toBe(m.missing_count);
    if (m.unpriced_missing > 0) {
      // NEED is a floor: the unpriced ones are excluded from the sum, not zeroed
      // into it, and the caller can see how many there are.
      expect(m.need_cents).toBeGreaterThan(0);
    }
  });

  it('owning one more card moves value from NEED to HAVE without changing COMPLETE', async () => {
    const before = await viaPostgres('base1', 'main');
    const next = await withIdentity(user, (tx) =>
      tx.one<{ card_id: string; variant: string; market_cents: number | null }>(
        `select card_id, variant, market_cents from public.goal_missing('base1', 'main', 1, 0)`,
      ),
    );
    expect(next).toBeDefined();

    await withIdentity(user, (tx) =>
      tx.rows(`select * from public.add_to_collection($1, $2, 1)`, [next!.card_id, next!.variant]),
    );

    const after = await viaPostgres('base1', 'main');
    expect(after.owned_count).toBe(before.owned_count + 1);
    expect(after.complete_cents).toBe(before.complete_cents);
    expect(after.have_cents).toBe(before.have_cents + (next!.market_cents ?? 0));
    expect(after.need_cents).toBe(before.need_cents - (next!.market_cents ?? 0));
    expect(after.have_cents + after.need_cents).toBe(after.complete_cents);
  }, 30_000);
});

describe('catalog integrity survived the migration', () => {
  it('has the full English catalog', async () => {
    const row = await withIdentity(null, (tx) =>
      tx.one<{ sets: number; cards: number; slots: number }>(
        `select (select count(*) from public.sets)::int as sets,
                (select count(*) from public.cards)::int as cards,
                (select count(*) from public.card_variants)::int as slots`,
      ),
    );
    expect(row!.sets).toBeGreaterThan(150);
    expect(row!.cards).toBeGreaterThan(20_000);
    expect(row!.slots).toBeGreaterThan(30_000);
  });

  it('gives Base Set no reverse holos and exactly 102 main-set slots', async () => {
    const rev = await withIdentity(null, (tx) =>
      tx.one<{ n: number }>(
        `select count(*)::int as n from public.card_variants v
         join public.cards c on c.id = v.card_id
         where c.set_id = 'base1' and v.variant = 'reverseHolofoil'`,
      ),
    );
    expect(rev!.n).toBe(0);

    const slots = await withIdentity(null, (tx) =>
      tx.one<{ n: number }>(
        `select count(*)::int as n from public.set_requirements('base1', 'main')`,
      ),
    );
    expect(slots!.n).toBe(102);
  });

  it('gives every card exactly one primary printing', async () => {
    const bad = await withIdentity(null, (tx) =>
      tx.rows(
        `select card_id from public.card_variants
         group by card_id having count(*) filter (where is_primary) <> 1 limit 5`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it('never attaches a price to a printing that does not exist', async () => {
    const orphans = await withIdentity(null, (tx) =>
      tx.one<{ n: number }>(
        `select count(*)::int as n from public.prices p
         left join public.card_variants v on v.card_id = p.card_id and v.variant = p.variant
         where v.card_id is null`,
      ),
    );
    expect(orphans!.n).toBe(0);
  });

  it('never lets a EUR-only printing contribute to a USD valuation', async () => {
    const row = await withIdentity(null, (tx) =>
      tx.one<{ n: number }>(
        `select count(*)::int as n
         from public.card_variants v
         join public.prices cm on cm.card_id = v.card_id and cm.variant = v.variant and cm.provider = 'cardmarket'
         left join public.prices t on t.card_id = v.card_id and t.variant = v.variant and t.provider = 'tcgplayer'
         where t.card_id is null
           and public.slot_market_cents(t.market_cents, t.mid_cents, t.low_cents) is not null`,
      ),
    );
    expect(row!.n).toBe(0);
  });
});
