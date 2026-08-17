import { describe, expect, it } from 'vitest';
import { inferVariants, isHoloOnlyRarity, primaryVariant } from '@/lib/catalog/variants';
import { toRequirement, type RawReqRow } from '@/lib/repo/catalog';
import { parseNumber } from '../scripts/ingest-catalog';

describe('inferVariants', () => {
  it('gives Base Set commons no reverse holo — they did not exist in 1999', () => {
    expect(
      inferVariants({ rarity: 'Common', setId: 'base1', setReleaseDate: '1999/01/09' }),
    ).toEqual(['normal']);
  });

  it('gives a modern common both a normal and a reverse holo printing', () => {
    expect(
      inferVariants({ rarity: 'Common', setId: 'sv3pt5', setReleaseDate: '2023/09/22' }),
    ).toEqual(['normal', 'reverseHolofoil']);
  });

  it('starts the reverse holo era at Legendary Collection', () => {
    // Legendary Collection, 2002-05-24, is the first set with reverse holos.
    expect(
      inferVariants({ rarity: 'Common', setId: 'base6', setReleaseDate: '2002/05/24' }),
    ).toContain('reverseHolofoil');
    expect(
      inferVariants({ rarity: 'Common', setId: 'neo4', setReleaseDate: '2002/02/28' }),
    ).not.toContain('reverseHolofoil');
  });

  it('gives holo-only rarities exactly one printing and never a reverse holo', () => {
    for (const rarity of [
      'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Illustration Rare',
      'Special Illustration Rare', 'Double Rare', 'Rare Rainbow',
    ]) {
      const v = inferVariants({ rarity, setId: 'sv3pt5', setReleaseDate: '2023/09/22' });
      expect(v, rarity).toEqual(['holofoil']);
    }
  });

  it('classifies rarities correctly', () => {
    expect(isHoloOnlyRarity('Rare Holo VMAX')).toBe(true);
    expect(isHoloOnlyRarity('Common')).toBe(false);
    expect(isHoloOnlyRarity('Rare')).toBe(false);
    expect(isHoloOnlyRarity(null)).toBe(false);
  });

  it('excludes promo-style sets from the reverse holo era', () => {
    expect(
      inferVariants({ rarity: 'Common', setId: 'mcd19', setReleaseDate: '2019/01/01' }),
    ).toEqual(['normal']);
  });
});

describe('primaryVariant', () => {
  it('prefers the base pack pull over the reverse holo', () => {
    expect(primaryVariant(['reverseHolofoil', 'normal'])).toBe('normal');
  });

  it('falls back to holofoil when there is no plain printing', () => {
    expect(primaryVariant(['holofoil', 'reverseHolofoil'])).toBe('holofoil');
  });

  it('prefers 1st edition ordering over unlimited', () => {
    expect(primaryVariant(['unlimitedHolofoil', '1stEditionHolofoil'])).toBe('1stEditionHolofoil');
  });
});

describe('price ladder', () => {
  const base: RawReqRow = {
    id: 'x-1', number: '1', number_sort: 1, name: 'X', rarity: 'Common',
    image_small: null, is_secret: 0, variant: 'normal', variant_source: 'market_data',
    is_primary: 1, market_cents: null, mid_cents: null, low_cents: null,
    direct_cents: null, observed_on: '2026-08-17',
  };

  it('prefers a market figure and records the basis', () => {
    const r = toRequirement({ ...base, market_cents: 500, mid_cents: 700, low_cents: 300 });
    expect(r.marketCents).toBe(500);
    expect(r.basis).toBe('market');
  });

  it('falls back to mid, then low, recording which one was used', () => {
    expect(toRequirement({ ...base, mid_cents: 700, low_cents: 300 }).basis).toBe('mid');
    expect(toRequirement({ ...base, low_cents: 300 }).basis).toBe('low');
  });

  it('returns null rather than zero when no figure exists', () => {
    const r = toRequirement(base);
    expect(r.marketCents).toBeNull();
    expect(r.basis).toBeNull();
    expect(r.acquisitionCents).toBeNull();
  });

  it('ignores zero-valued figures instead of treating them as free', () => {
    const r = toRequirement({ ...base, market_cents: 0, mid_cents: 250 });
    expect(r.marketCents).toBe(250);
    expect(r.basis).toBe('mid');
  });

  it('picks the cheapest credible route for acquisition cost', () => {
    const r = toRequirement({
      ...base, market_cents: 500, mid_cents: 700, low_cents: 300, direct_cents: 275,
    });
    expect(r.acquisitionCents).toBe(275);
  });
});

describe('card number parsing', () => {
  it('sorts plain numbers naturally rather than as strings', () => {
    expect(parseNumber('9').n).toBeLessThan(parseNumber('10').n);
    expect(parseNumber('99').n).toBeLessThan(parseNumber('100').n);
  });

  it('keeps letter suffixes attached to their number', () => {
    expect(parseNumber('4a')).toEqual({ n: 4, suffix: 'a' });
  });

  it('sorts prefixed subsets after the main run', () => {
    expect(parseNumber('TG05').n).toBeGreaterThan(parseNumber('300').n);
    expect(parseNumber('SWSH001').n).toBeGreaterThan(parseNumber('999').n);
  });
});
