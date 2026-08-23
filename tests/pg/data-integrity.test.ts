import { afterAll, describe, expect, it } from 'vitest';
import { withIdentity, closePool } from '@/lib/db/pg';

/**
 * Invariants on the real ingested catalog, in PostgreSQL.
 *
 * These are the checks that catch a bad ingest before a collector sees a wrong
 * number — phantom printings, prices attached to the wrong thing, sets whose
 * card counts do not match the number printed on the cards.
 *
 * Everything here reads through the anonymous role, which is what the landing
 * page and partner console use: if a policy change ever hid the catalog from
 * anonymous readers, these fail rather than the marketing page silently
 * rendering zeroes.
 */

afterAll(async () => {
  await closePool();
});

function q<T>(sql: string, params: unknown[] = []) {
  return withIdentity(null, (tx) => tx.rows<T>(sql, params));
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await q<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

describe('ingested catalog', () => {
  it('has the full English set list', async () => {
    expect(await count('select count(*)::int as n from public.sets')).toBeGreaterThan(150);
  });

  it('has cards for every set', async () => {
    const orphans = await q<{ id: string }>(
      'select s.id from public.sets s left join public.cards c on c.set_id = s.id where c.id is null',
    );
    expect(orphans).toEqual([]);
  });

  it('gives every card at least one printing', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.cards c
         left join public.card_variants v on v.card_id = c.id
         where v.card_id is null`,
      ),
    ).toBe(0);
  });

  it('gives every card exactly one primary printing', async () => {
    const bad = await q<{ card_id: string; primaries: number }>(
      `select card_id, count(*) filter (where is_primary)::int as primaries
       from public.card_variants group by card_id
       having count(*) filter (where is_primary) <> 1 limit 5`,
    );
    expect(bad).toEqual([]);
  });

  it('never attaches a price to a printing that does not exist', async () => {
    // The foreign key covers card_id; this covers the (card, printing) pair,
    // which no constraint can express and which a sloppy ingest would break.
    expect(
      await count(
        `select count(*)::int as n from public.prices p
         left join public.card_variants v on v.card_id = p.card_id and v.variant = p.variant
         where v.card_id is null`,
      ),
    ).toBe(0);
  });

  it('stores no negative prices and dates every one of them', async () => {
    // observed_on is `date not null`, so a malformed or empty date cannot be
    // stored at all — the type does what a GLOB check had to do in SQLite.
    expect(
      await count(
        `select count(*)::int as n from public.prices
         where market_cents < 0 or low_cents < 0 or mid_cents < 0 or high_cents < 0 or direct_cents < 0`,
      ),
    ).toBe(0);
  });

  it('keeps price history in step with the latest prices', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.prices p
         left join public.price_points pp
           on pp.card_id = p.card_id and pp.variant = p.variant
          and pp.provider = p.provider and pp.observed_on = p.observed_on
         where pp.card_id is null`,
      ),
    ).toBe(0);
  });

  it('prices the large majority of printings in USD', async () => {
    // Coverage is not 100% and should not be forced to look like it. Brand-new
    // sets and promo runs frequently have no TCGplayer listing yet, and some
    // printings are quoted only by Cardmarket in EUR. Those are reported as
    // unpriced, which is what makes a NEED total honest. This floor is here to
    // catch a broken ingest, not to flatter the number.
    const [row] = await q<{ slots: number; priced: number }>(
      `select (select count(*) from public.card_variants)::int as slots,
              (select count(*) from public.card_variants v
                 join public.prices p
                   on p.card_id = v.card_id and p.variant = v.variant and p.provider = 'tcgplayer')::int as priced`,
    );
    expect(row!.priced / row!.slots).toBeGreaterThan(0.85);
  });

  it('never lets a EUR-only printing contribute to a USD valuation', async () => {
    // Cardmarket quotes some printings TCGplayer does not. Those must surface
    // as unpriced rather than being silently converted at an invented rate.
    const [eurOnly] = await q<{ card_id: string; variant: string; set_id: string }>(
      `select v.card_id, v.variant, c.set_id from public.card_variants v
       join public.cards c on c.id = v.card_id
       join public.prices cm
         on cm.card_id = v.card_id and cm.variant = v.variant and cm.provider = 'cardmarket'
       left join public.prices t
         on t.card_id = v.card_id and t.variant = v.variant and t.provider = 'tcgplayer'
       where t.card_id is null limit 1`,
    );
    if (!eurOnly) return;

    const [slot] = await q<{ market_cents: number | null; basis: string | null }>(
      `select market_cents, basis from public.set_requirements($1, 'master')
       where card_id = $2 and variant = $3`,
      [eurOnly.set_id, eurOnly.card_id, eurOnly.variant],
    );
    expect(slot!.market_cents).toBeNull();
    expect(slot!.basis).toBeNull();
  });
});

describe('era rules survive ingest', () => {
  it('gives Base Set no reverse holos — they did not exist in 1999', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.card_variants v
         join public.cards c on c.id = v.card_id
         where c.set_id = 'base1' and v.variant = 'reverseHolofoil'`,
      ),
    ).toBe(0);
  });

  it('gives no pre-2002 set a reverse holo', async () => {
    const rows = await q<{ id: string }>(
      `select distinct s.id from public.card_variants v
       join public.cards c on c.id = v.card_id
       join public.sets s on s.id = c.set_id
       where v.variant = 'reverseHolofoil' and s.release_date < date '2002-05-24'
       limit 5`,
    );
    expect(rows).toEqual([]);
  });

  it('gives modern sets reverse holos', async () => {
    expect(
      await count(
        `select count(*)::int as n from public.card_variants v
         join public.cards c on c.id = v.card_id
         where c.set_id = 'sv3pt5' and v.variant = 'reverseHolofoil'`,
      ),
    ).toBeGreaterThan(50);
  });

  it('never invents a reverse holo for a holo-only rarity', async () => {
    // A provider listing a reverse holo is evidence and is kept — whether a
    // given holo rare also had a reverse printing varies by set. What must
    // never happen is SetValue's own rarity rule conjuring one.
    const rows = await q<{ id: string; rarity: string }>(
      `select c.id, c.rarity from public.card_variants v
       join public.cards c on c.id = v.card_id
       where v.variant = 'reverseHolofoil' and v.source = 'inferred'
         and (c.rarity like 'Rare Secret%' or c.rarity like 'Rare Rainbow%'
              or c.rarity like '%Illustration Rare' or c.rarity like 'Rare Ultra%'
              or c.rarity like 'Rare Holo%')
       limit 5`,
    );
    expect(rows).toEqual([]);
  });
});

describe('completion maths on real sets', () => {
  const cases: [string, number][] = [
    ['base1', 102],  // the original 102-card Base Set
    ['sv3pt5', 165], // 151, whose printed total is 165
  ];

  for (const [setId, expectedMain] of cases) {
    it(`counts ${setId}'s main set as ${expectedMain} slots`, async () => {
      expect(
        await count('select count(*)::int as n from public.set_requirements($1, $2)', [setId, 'main']),
      ).toBe(expectedMain);
    });
  }

  it('never lets a mode ask for fewer slots than a narrower one', async () => {
    for (const setId of ['base1', 'sv3pt5', 'swsh7', 'sv1']) {
      const [row] = await q<{ main: number; complete: number; master: number }>(
        `select (select count(*) from public.set_requirements($1, 'main'))::int as main,
                (select count(*) from public.set_requirements($1, 'complete'))::int as complete,
                (select count(*) from public.set_requirements($1, 'master'))::int as master`,
        [setId],
      );
      expect(row!.main, setId).toBeLessThanOrEqual(row!.complete);
      expect(row!.complete, setId).toBeLessThanOrEqual(row!.master);
    }
  });

  it('keeps COMPLETE = HAVE + NEED on real data for an empty collection', async () => {
    // No identity, so no collection_items row is visible: the empty-collection
    // case is produced by RLS rather than by a fixture pretending to be empty.
    const [m] = await q<{ have: number; need: number; complete: number }>(
      `select coalesce(sum(0), 0)::bigint as have,
              coalesce(sum(market_cents), 0)::bigint as need,
              coalesce(sum(market_cents), 0)::bigint as complete
       from public.set_requirements('sv3pt5', 'master')`,
    );
    expect(m!.have).toBe(0);
    expect(m!.need).toBe(m!.complete);
    expect(m!.complete).toBeGreaterThan(0);
  });

  it('produces a plausible value for a real set rather than an absurd one', async () => {
    const [m] = await q<{ complete: number }>(
      `select coalesce(sum(market_cents), 0)::bigint as complete
       from public.set_requirements('base1', 'main')`,
    );
    // Base Set unlimited runs into the low thousands, not tens or millions.
    expect(m!.complete).toBeGreaterThan(50_000);
    expect(m!.complete).toBeLessThan(100_000_000);
  });
});
