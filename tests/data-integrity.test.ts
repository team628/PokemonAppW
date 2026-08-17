import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from '@/lib/db';
import { primaryVariantMap, setRequirements } from '@/lib/repo/catalog';
import { computeGoal, requirementsForMode } from '@/lib/domain/goals';

/**
 * Invariants on the real ingested catalog.
 *
 * These are the checks that catch a bad ingest before a collector sees a wrong
 * number — phantom printings, prices attached to the wrong thing, sets whose
 * card counts do not match the number printed on the cards.
 */

const DB_PATH = path.join(process.cwd(), 'data', 'setvalue.db');
const hasData = existsSync(DB_PATH);
const describeData = hasData ? describe : describe.skip;

let db: DB | undefined;
if (hasData) db = openDb(DB_PATH);
afterAll(() => db?.close());

describeData('ingested catalog', () => {
  it('has the full English set list', () => {
    const { n } = db!.prepare('SELECT COUNT(*) AS n FROM sets').get() as { n: number };
    expect(n).toBeGreaterThan(150);
  });

  it('has cards for every set', () => {
    const orphans = db!
      .prepare('SELECT s.id FROM sets s LEFT JOIN cards c ON c.set_id = s.id WHERE c.id IS NULL')
      .all() as { id: string }[];
    expect(orphans).toEqual([]);
  });

  it('gives every card at least one printing', () => {
    const { n } = db!
      .prepare('SELECT COUNT(*) AS n FROM cards c LEFT JOIN card_variants v ON v.card_id = c.id WHERE v.card_id IS NULL')
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it('gives every card exactly one primary printing', () => {
    const bad = db!
      .prepare(
        `SELECT card_id, SUM(is_primary) AS primaries FROM card_variants
         GROUP BY card_id HAVING primaries != 1 LIMIT 5`,
      )
      .all() as { card_id: string; primaries: number }[];
    expect(bad).toEqual([]);
  });

  it('never attaches a price to a printing that does not exist', () => {
    const { n } = db!
      .prepare(
        `SELECT COUNT(*) AS n FROM prices p
         LEFT JOIN card_variants v ON v.card_id = p.card_id AND v.variant = p.variant
         WHERE v.card_id IS NULL`,
      )
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it('stores no negative or zero-dated prices', () => {
    const { n } = db!
      .prepare(
        `SELECT COUNT(*) AS n FROM prices
         WHERE market_cents < 0 OR low_cents < 0 OR observed_on IS NULL OR observed_on = ''`,
      )
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it('dates every price with a real ISO day', () => {
    const bad = db!
      .prepare("SELECT observed_on FROM prices WHERE observed_on NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' LIMIT 3")
      .all() as { observed_on: string }[];
    expect(bad).toEqual([]);
  });

  it('keeps price history in step with the latest prices', () => {
    const { n } = db!
      .prepare(
        `SELECT COUNT(*) AS n FROM prices p
         LEFT JOIN price_points pp
           ON pp.card_id = p.card_id AND pp.variant = p.variant
          AND pp.provider = p.provider AND pp.observed_on = p.observed_on
         WHERE pp.card_id IS NULL`,
      )
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it('prices the large majority of printings in USD', () => {
    // Coverage is not 100% and should not be forced to look like it. Brand-new
    // sets and promo runs frequently have no TCGplayer listing yet, and some
    // printings are quoted only by Cardmarket in EUR. Those are reported as
    // unpriced, which is what makes a NEED total honest. This floor is here to
    // catch a broken ingest, not to flatter the number.
    const { slots, priced } = db!
      .prepare(
        `SELECT (SELECT COUNT(*) FROM card_variants) AS slots,
                (SELECT COUNT(*) FROM card_variants v
                   JOIN prices p ON p.card_id=v.card_id AND p.variant=v.variant AND p.provider='tcgplayer') AS priced`,
      )
      .get() as { slots: number; priced: number };
    expect(priced / slots).toBeGreaterThan(0.85);
  });

  it('never lets a EUR-only printing contribute to a USD valuation', () => {
    // Cardmarket quotes some printings TCGplayer does not. Those must surface
    // as unpriced rather than being silently converted at an invented rate.
    const eurOnly = db!
      .prepare(
        `SELECT v.card_id, v.variant FROM card_variants v
         JOIN prices cm ON cm.card_id=v.card_id AND cm.variant=v.variant AND cm.provider='cardmarket'
         LEFT JOIN prices t ON t.card_id=v.card_id AND t.variant=v.variant AND t.provider='tcgplayer'
         WHERE t.card_id IS NULL LIMIT 1`,
      )
      .get() as { card_id: string; variant: string } | undefined;
    if (!eurOnly) return;

    const all = setRequirements(
      db!,
      (db!.prepare('SELECT set_id FROM cards WHERE id = ?').get(eurOnly.card_id) as { set_id: string }).set_id,
    );
    const slot = all.find((r) => r.cardId === eurOnly.card_id && r.variant === eurOnly.variant)!;
    expect(slot.marketCents).toBeNull();
    expect(slot.basis).toBeNull();
  });
});

describeData('era rules survive ingest', () => {
  it('gives Base Set no reverse holos — they did not exist in 1999', () => {
    const { n } = db!
      .prepare(
        "SELECT COUNT(*) AS n FROM card_variants v JOIN cards c ON c.id=v.card_id WHERE c.set_id='base1' AND v.variant='reverseHolofoil'",
      )
      .get() as { n: number };
    expect(n).toBe(0);
  });

  it('gives no pre-2002 set a reverse holo', () => {
    const rows = db!
      .prepare(
        `SELECT DISTINCT s.id, s.release_date FROM card_variants v
         JOIN cards c ON c.id = v.card_id
         JOIN sets s ON s.id = c.set_id
         WHERE v.variant = 'reverseHolofoil' AND s.release_date < '2002/05/24'
         LIMIT 5`,
      )
      .all() as { id: string; release_date: string }[];
    expect(rows).toEqual([]);
  });

  it('gives modern sets reverse holos', () => {
    const { n } = db!
      .prepare(
        "SELECT COUNT(*) AS n FROM card_variants v JOIN cards c ON c.id=v.card_id WHERE c.set_id='sv3pt5' AND v.variant='reverseHolofoil'",
      )
      .get() as { n: number };
    expect(n).toBeGreaterThan(50);
  });

  it('never invents a reverse holo for a holo-only rarity', () => {
    // A provider listing a reverse holo is evidence and is kept — whether a
    // given holo rare also had a reverse printing varies by set. What must
    // never happen is SetValue's own rarity rule conjuring one.
    const rows = db!
      .prepare(
        `SELECT c.id, c.rarity FROM card_variants v JOIN cards c ON c.id = v.card_id
         WHERE v.variant = 'reverseHolofoil' AND v.source = 'inferred'
           AND (c.rarity LIKE 'Rare Secret%' OR c.rarity LIKE 'Rare Rainbow%'
                OR c.rarity LIKE '%Illustration Rare' OR c.rarity LIKE 'Rare Ultra%'
                OR c.rarity LIKE 'Rare Holo%')
         LIMIT 5`,
      )
      .all() as { id: string; rarity: string }[];
    expect(rows).toEqual([]);
  });
});

describeData('completion maths on real sets', () => {
  const cases: [string, number][] = [
    ['base1', 102],  // the original 102-card Base Set
    ['sv3pt5', 165], // 151, whose printed total is 165
  ];

  for (const [setId, expectedMain] of cases) {
    it(`counts ${setId}'s main set as ${expectedMain} slots`, () => {
      const all = setRequirements(db!, setId);
      const primaries = primaryVariantMap(db!, setId);
      expect(requirementsForMode(all, 'main', primaries)).toHaveLength(expectedMain);
    });
  }

  it('never lets a mode ask for fewer slots than a narrower one', () => {
    for (const setId of ['base1', 'sv3pt5', 'swsh7', 'sv1']) {
      const all = setRequirements(db!, setId);
      const primaries = primaryVariantMap(db!, setId);
      const main = requirementsForMode(all, 'main', primaries).length;
      const complete = requirementsForMode(all, 'complete', primaries).length;
      const master = requirementsForMode(all, 'master', primaries).length;
      expect(main, setId).toBeLessThanOrEqual(complete);
      expect(complete, setId).toBeLessThanOrEqual(master);
    }
  });

  it('keeps COMPLETE = HAVE + NEED on real data for an empty collection', () => {
    const all = setRequirements(db!, 'sv3pt5');
    const primaries = primaryVariantMap(db!, 'sv3pt5');
    const m = computeGoal('master', requirementsForMode(all, 'master', primaries), new Map());
    expect(m.haveCents).toBe(0);
    expect(m.needCents).toBe(m.completeCents);
    expect(m.completeCents).toBeGreaterThan(0);
  });

  it('produces a plausible value for a real set rather than an absurd one', () => {
    const all = setRequirements(db!, 'base1');
    const primaries = primaryVariantMap(db!, 'base1');
    const m = computeGoal('main', requirementsForMode(all, 'main', primaries), new Map());
    // Base Set unlimited runs into the low thousands, not tens or millions.
    expect(m.completeCents).toBeGreaterThan(50_000);
    expect(m.completeCents).toBeLessThan(100_000_000);
  });
});
