import { describe, expect, it } from 'vitest';
import {
  computeGoal,
  milestonesFor,
  ownedIndex,
  requirementsForMode,
  type Requirement,
} from '@/lib/domain/goals';
import type { Variant } from '@/lib/catalog/variants';

function req(over: Partial<Requirement> & { cardId: string; variant: Variant }): Requirement {
  return {
    number: '1',
    numberSort: 1,
    name: 'Test Card',
    rarity: 'Common',
    imageSmall: null,
    isSecret: false,
    marketCents: 100,
    acquisitionCents: 80,
    basis: 'market',
    observedOn: '2026-08-17',
    variantSource: 'market_data',
    ...over,
  };
}

describe('computeGoal', () => {
  const requirements = [
    req({ cardId: 'a', variant: 'normal', marketCents: 500, acquisitionCents: 400 }),
    req({ cardId: 'b', variant: 'normal', marketCents: 250, acquisitionCents: 200 }),
    req({ cardId: 'c', variant: 'normal', marketCents: 125, acquisitionCents: 100 }),
    req({ cardId: 'd', variant: 'normal', marketCents: 25, acquisitionCents: 20 }),
  ];

  it('splits owned from missing by (card, printing)', () => {
    const owned = ownedIndex([{ cardId: 'a', variant: 'normal', quantity: 1 }]);
    const m = computeGoal('main', requirements, owned);
    expect(m.ownedCount).toBe(1);
    expect(m.missingCount).toBe(3);
    expect(m.missing.map((r) => r.cardId)).toEqual(['b', 'c', 'd']);
  });

  it('does not credit ownership of a different printing of the same card', () => {
    const owned = ownedIndex([{ cardId: 'a', variant: 'reverseHolofoil', quantity: 3 }]);
    const m = computeGoal('main', requirements, owned);
    expect(m.ownedCount).toBe(0);
    expect(m.missingCount).toBe(4);
  });

  it('ignores rows with zero quantity', () => {
    const owned = ownedIndex([{ cardId: 'a', variant: 'normal', quantity: 0 }]);
    expect(computeGoal('main', requirements, owned).ownedCount).toBe(0);
  });

  it('keeps COMPLETE = HAVE + NEED exactly', () => {
    const owned = ownedIndex([
      { cardId: 'a', variant: 'normal', quantity: 1 },
      { cardId: 'c', variant: 'normal', quantity: 2 },
    ]);
    const m = computeGoal('main', requirements, owned);
    expect(m.haveCents).toBe(625);
    expect(m.needCents).toBe(275);
    expect(m.completeCents).toBe(900);
    expect(m.completeCents).toBe(m.haveCents + m.needCents);
  });

  it('reports percent from slot counts, not dollars', () => {
    const owned = ownedIndex([{ cardId: 'a', variant: 'normal', quantity: 1 }]);
    const m = computeGoal('main', requirements, owned);
    expect(m.percent).toBe(0.25);
  });

  it('treats an unpriced card as unknown, never as zero, and flags NEED as a floor', () => {
    const withUnpriced = [
      ...requirements,
      req({ cardId: 'e', variant: 'normal', marketCents: null, acquisitionCents: null, basis: null }),
    ];
    const m = computeGoal('main', withUnpriced, new Map());
    expect(m.missingCount).toBe(5);
    expect(m.pricedMissing).toBe(4);
    expect(m.unpricedMissing).toBe(1);
    expect(m.needIsFloor).toBe(true);
    // The unpriced card contributes nothing rather than dragging the total down.
    expect(m.needCents).toBe(900);
  });

  it('does not flag a floor when every missing card is priced', () => {
    expect(computeGoal('main', requirements, new Map()).needIsFloor).toBe(false);
  });

  it('reports the oldest contributing observation date', () => {
    const dated = [
      req({ cardId: 'a', variant: 'normal', observedOn: '2026-08-17' }),
      req({ cardId: 'b', variant: 'normal', observedOn: '2026-06-01' }),
      req({ cardId: 'c', variant: 'normal', observedOn: '2026-07-15' }),
    ];
    expect(computeGoal('main', dated, new Map()).oldestObservation).toBe('2026-06-01');
  });

  it('reports the share of printings confirmed by market data', () => {
    const mixed = [
      req({ cardId: 'a', variant: 'normal', variantSource: 'market_data' }),
      req({ cardId: 'b', variant: 'normal', variantSource: 'market_data' }),
      req({ cardId: 'c', variant: 'normal', variantSource: 'inferred' }),
      req({ cardId: 'd', variant: 'normal', variantSource: 'inferred' }),
    ];
    expect(computeGoal('main', mixed, new Map()).variantConfidence).toBe(0.5);
  });

  it('handles an empty goal without dividing by zero', () => {
    const m = computeGoal('main', [], new Map());
    expect(m.percent).toBe(0);
    expect(m.completeCents).toBe(0);
    expect(milestonesFor(m)).not.toContain('complete');
  });
});

describe('requirementsForMode', () => {
  const all: Requirement[] = [
    req({ cardId: 'a', variant: 'normal', numberSort: 1 }),
    req({ cardId: 'a', variant: 'reverseHolofoil', numberSort: 1 }),
    req({ cardId: 'b', variant: 'holofoil', numberSort: 2 }),
    req({ cardId: 'secret', variant: 'holofoil', numberSort: 200, isSecret: true }),
  ];
  const primaries = new Map<string, Variant>([
    ['a', 'normal'],
    ['b', 'holofoil'],
    ['secret', 'holofoil'],
  ]);

  it('main set: one printing each, secrets excluded', () => {
    const r = requirementsForMode(all, 'main', primaries);
    expect(r.map((x) => `${x.cardId}:${x.variant}`)).toEqual(['a:normal', 'b:holofoil']);
  });

  it('complete set: one printing each, secrets included', () => {
    const r = requirementsForMode(all, 'complete', primaries);
    expect(r.map((x) => x.cardId)).toEqual(['a', 'b', 'secret']);
  });

  it('master set: every printing of every card', () => {
    expect(requirementsForMode(all, 'master', primaries)).toHaveLength(4);
  });
});

describe('milestonesFor', () => {
  const make = (owned: number, total: number) =>
    computeGoal(
      'main',
      Array.from({ length: total }, (_, i) => req({ cardId: `c${i}`, variant: 'normal' })),
      ownedIndex(Array.from({ length: owned }, (_, i) => ({ cardId: `c${i}`, variant: 'normal' as Variant, quantity: 1 }))),
    );

  it('fires nothing for an untouched set', () => {
    expect(milestonesFor(make(0, 100))).toEqual([]);
  });

  it('never congratulates a collector for starting a small set', () => {
    // A five-card set is entirely "missing" the moment it is tracked. Saying
    // "final five, every one counts now" there is a celebration of nothing.
    expect(milestonesFor(make(0, 5))).toEqual([]);
    expect(milestonesFor(make(0, 1))).toEqual([]);
  });

  it('does not call a five-card set the "final five", but does call one card "one left"', () => {
    // On a five-card set the whole thing is the final five from the start, so
    // that milestone is meaningless. "One left" stays: with four of five owned,
    // a single card really does stand between the collector and a finished set.
    const small = milestonesFor(make(4, 5));
    expect(small).not.toContain('final_five');
    expect(small).toContain('one_left');
    expect(small).toContain('started');
  });

  it('fires started on the first card', () => {
    expect(milestonesFor(make(1, 100))).toEqual(['started']);
  });

  it('accumulates percentage milestones', () => {
    expect(milestonesFor(make(50, 100))).toEqual(['started', 'pct25', 'pct50']);
  });

  it('fires final_five and one_left near the end', () => {
    expect(milestonesFor(make(99, 100))).toContain('one_left');
    expect(milestonesFor(make(99, 100))).toContain('final_five');
    expect(milestonesFor(make(96, 100))).toContain('final_five');
    expect(milestonesFor(make(96, 100))).not.toContain('one_left');
  });

  it('fires complete only when nothing is missing', () => {
    expect(milestonesFor(make(100, 100))).toContain('complete');
    expect(milestonesFor(make(99, 100))).not.toContain('complete');
    // "one left" must not linger once the set is done.
    expect(milestonesFor(make(100, 100))).not.toContain('one_left');
  });
});
