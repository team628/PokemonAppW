import { describe, expect, it } from 'vitest';
import {
  affordablePrefix,
  computeMoves,
  type MoveContext,
} from '@/lib/domain/nextBestMove';
import { computeGoal, type Requirement } from '@/lib/domain/goals';
import type { Variant } from '@/lib/catalog/variants';

function req(cardId: string, acq: number | null, market = acq): Requirement {
  return {
    cardId,
    variant: 'normal' as Variant,
    number: cardId,
    numberSort: 1,
    name: `Card ${cardId}`,
    rarity: 'Common',
    imageSmall: null,
    isSecret: false,
    marketCents: market,
    acquisitionCents: acq,
    basis: 'market',
    observedOn: '2026-08-17',
    variantSource: 'market_data',
  };
}

function goalWith(missing: Requirement[], ownedCount: number) {
  const owned = Array.from({ length: ownedCount }, (_, i) => req(`owned${i}`, 100));
  const metrics = computeGoal('main', [...owned, ...missing], new Map(
    owned.map((o) => [`${o.cardId}::${o.variant}`, 1]),
  ));
  return {
    goalId: 'g1',
    setId: 's1',
    setName: 'Test Set',
    mode: 'main' as const,
    metrics,
  };
}

const empty: MoveContext = { goals: [], dupes: [], tradeMatches: [], priceDrops: [] };

describe('affordablePrefix', () => {
  it('takes the cheapest cards first, maximising slots per dollar', () => {
    const missing = [req('a', 900), req('b', 100), req('c', 200), req('d', 300)];
    const { picked, costCents } = affordablePrefix(missing, 700);
    expect(picked.map((p) => p.cardId)).toEqual(['b', 'c', 'd']);
    expect(costCents).toBe(600);
  });

  it('never exceeds the budget', () => {
    const missing = [req('a', 400), req('b', 400)];
    const { picked, costCents } = affordablePrefix(missing, 500);
    expect(picked).toHaveLength(1);
    expect(costCents).toBeLessThanOrEqual(500);
  });

  it('skips cards with no price rather than assuming they are free', () => {
    const missing = [req('a', null), req('b', 100)];
    const { picked } = affordablePrefix(missing, 10_000);
    expect(picked.map((p) => p.cardId)).toEqual(['b']);
  });

  it('returns nothing when the budget covers nothing', () => {
    expect(affordablePrefix([req('a', 500)], 100).picked).toHaveLength(0);
  });
});

describe('computeMoves', () => {
  it('promotes a nearly finished set above everything else', () => {
    const ctx: MoveContext = {
      ...empty,
      goals: [goalWith([req('m1', 500), req('m2', 300)], 98)],
    };
    const moves = computeMoves(ctx);
    expect(moves[0]!.kind).toBe('finish_line');
    expect(moves[0]!.headline).toContain('2 cards from finishing');
    expect(moves[0]!.costCents).toBe(800);
  });

  it('uses the singular for a set one card from done', () => {
    const moves = computeMoves({ ...empty, goals: [goalWith([req('m1', 500)], 99)] });
    expect(moves[0]!.headline).toContain('One card from finishing');
  });

  it('marks a finish-line move as an estimate when a card has no listing', () => {
    const moves = computeMoves({
      ...empty,
      goals: [goalWith([req('m1', 500), req('m2', null)], 98)],
    });
    expect(moves[0]!.confidence).toBe('estimated');
    expect(moves[0]!.detail).toContain('no current listing');
  });

  it('builds a budget bundle and states the completion it buys', () => {
    const missing = Array.from({ length: 20 }, (_, i) => req(`m${i}`, (i + 1) * 100));
    const moves = computeMoves({ ...empty, goals: [goalWith(missing, 80)], budgetCents: 1000 });
    const bundle = moves.find((m) => m.kind === 'cheap_bundle');
    expect(bundle).toBeDefined();
    expect(bundle!.costCents).toBeLessThanOrEqual(1000);
    expect(bundle!.evidence.length).toBeGreaterThan(0);
    expect(bundle!.detail).toMatch(/complete/);
  });

  it('surfaces a bulk-fill move for a pile of sub-50c cards', () => {
    const missing = Array.from({ length: 12 }, (_, i) => req(`m${i}`, 25));
    const moves = computeMoves({ ...empty, goals: [goalWith(missing, 50)] });
    const bulk = moves.find((m) => m.kind === 'bulk_fill');
    expect(bulk).toBeDefined();
    expect(bulk!.costCents).toBe(300);
  });

  it('stays silent about price movement when there is no history', () => {
    const missing = Array.from({ length: 10 }, (_, i) => req(`m${i}`, 500));
    const moves = computeMoves({ ...empty, goals: [goalWith(missing, 50)], priceDrops: [] });
    expect(moves.some((m) => m.kind === 'price_drop')).toBe(false);
  });

  it('reports a price drop only from two dated observations', () => {
    const moves = computeMoves({
      ...empty,
      goals: [goalWith([req('m1', 500)], 50)],
      priceDrops: [
        {
          cardId: 'm1', name: 'Card m1', number: '1', variant: 'normal', setId: 's1',
          imageSmall: null, currentCents: 400, previousCents: 800,
          previousOn: '2026-08-10', currentOn: '2026-08-17',
        },
      ],
    });
    const drop = moves.find((m) => m.kind === 'price_drop');
    expect(drop).toBeDefined();
    expect(drop!.basis).toContain('2026-08-10');
    expect(drop!.basis).toContain('2026-08-17');
    expect(drop!.confidence).toBe('measured');
  });

  it('never recommends a finished set', () => {
    const moves = computeMoves({ ...empty, goals: [goalWith([], 100)] });
    expect(moves.filter((m) => m.setId === 's1')).toHaveLength(0);
  });

  it('values duplicates against what is left to buy', () => {
    const moves = computeMoves({
      ...empty,
      goals: [goalWith([req('m1', 2000)], 50)],
      dupes: [
        {
          cardId: 'd1', name: 'Spare', number: '9', variant: 'normal',
          imageSmall: null, spareCopies: 2, unitValueCents: 2500,
        },
      ],
    });
    const dup = moves.find((m) => m.kind === 'duplicate_leverage');
    expect(dup).toBeDefined();
    expect(dup!.headline).toContain('$50.00');
    expect(dup!.detail).toContain('more than');
  });

  it('ignores duplicates that carry no value', () => {
    const moves = computeMoves({
      ...empty,
      goals: [goalWith([req('m1', 2000)], 50)],
      dupes: [
        { cardId: 'd1', name: 'Spare', number: '9', variant: 'normal', imageSmall: null, spareCopies: 5, unitValueCents: null },
      ],
    });
    expect(moves.some((m) => m.kind === 'duplicate_leverage')).toBe(false);
  });

  it('only calls a trade a match when it runs both ways', () => {
    const oneWay = computeMoves({
      ...empty,
      goals: [goalWith([req('m1', 500)], 50)],
      tradeMatches: [
        {
          cardId: 'm1', name: 'Card m1', number: '1', variant: 'normal', imageSmall: null,
          valueCents: 500, counterpartHandle: 'ash', counterpartDisplayName: 'Ash', mutual: false,
        },
      ],
    });
    expect(oneWay.some((m) => m.kind === 'trade_match')).toBe(false);
  });

  it('tells a brand new collector to pick a set', () => {
    const moves = computeMoves(empty);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.kind).toBe('start_tracking');
  });

  it('returns moves sorted by score, highest first', () => {
    const missing = Array.from({ length: 12 }, (_, i) => req(`m${i}`, 25));
    const moves = computeMoves({ ...empty, goals: [goalWith(missing, 50)] });
    const scores = moves.map((m) => m.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('attaches inspectable evidence to every non-trivial move', () => {
    const missing = Array.from({ length: 12 }, (_, i) => req(`m${i}`, 100 * (i + 1)));
    const moves = computeMoves({ ...empty, goals: [goalWith(missing, 50)] });
    for (const m of moves) {
      expect(m.basis.length, m.kind).toBeGreaterThan(10);
      if (m.kind !== 'start_tracking') expect(m.evidence.length, m.kind).toBeGreaterThan(0);
    }
  });
});
