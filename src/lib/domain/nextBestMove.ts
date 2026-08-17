import type { GoalMetrics, GoalMode, Requirement } from './goals';

/**
 * Next Best Move.
 *
 * This is a recommendation engine, which means the standard it has to meet is
 * not "does it produce a suggestion" but "can every suggestion be justified
 * from data the collector can inspect". So:
 *
 *  - Every move carries `evidence`: the specific cards and prices behind it.
 *  - Every move carries `basis`, describing what kind of claim it is.
 *  - A move that would need data we don't have is not emitted at all. In
 *    particular, price-movement moves require at least two provider
 *    observations on different dates; with a single snapshot the engine stays
 *    silent rather than inventing a trend.
 */

export type MoveKind =
  | 'finish_line'
  | 'cheap_bundle'
  | 'bulk_fill'
  | 'price_drop'
  | 'duplicate_leverage'
  | 'trade_match'
  | 'start_tracking';

export interface MoveEvidence {
  cardId: string;
  name: string;
  number: string;
  variant: string;
  imageSmall: string | null;
  cents: number | null;
  note?: string;
}

export interface Move {
  kind: MoveKind;
  goalId?: string;
  setId?: string;
  setName?: string;
  mode?: GoalMode;
  headline: string;
  detail: string;
  /** Cash this move asks for, USD cents. null when the move costs nothing. */
  costCents: number | null;
  /** Completion the move buys, in percentage points. */
  deltaPoints: number;
  score: number;
  evidence: MoveEvidence[];
  /** Plain-language statement of what kind of claim this is. */
  basis: string;
  confidence: 'measured' | 'estimated';
}

export interface GoalInput {
  goalId: string;
  setId: string;
  setName: string;
  mode: GoalMode;
  metrics: GoalMetrics;
}

export interface DupeInput {
  cardId: string;
  name: string;
  number: string;
  variant: string;
  imageSmall: string | null;
  spareCopies: number;
  unitValueCents: number | null;
}

export interface TradeMatchInput {
  cardId: string;
  name: string;
  number: string;
  variant: string;
  imageSmall: string | null;
  valueCents: number | null;
  counterpartHandle: string;
  counterpartDisplayName: string;
  /** true when the other collector also has something this collector needs. */
  mutual: boolean;
}

export interface PriceDropInput {
  cardId: string;
  name: string;
  number: string;
  variant: string;
  setId: string;
  imageSmall: string | null;
  currentCents: number;
  previousCents: number;
  previousOn: string;
  currentOn: string;
}

export interface MoveContext {
  goals: GoalInput[];
  dupes: DupeInput[];
  tradeMatches: TradeMatchInput[];
  priceDrops: PriceDropInput[];
  /** Cash the collector said they have available, USD cents. */
  budgetCents?: number | null;
}

const money = (c: number) =>
  `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Ranking bands.
 *
 * Scores are banded rather than free-floating so the order is explainable and
 * stays stable: a move that finishes a set always outranks one that merely
 * advances it, which always outranks one that only tells you something. Inside
 * a band, completion per dollar decides.
 *
 * The band order encodes a judgement about what a collector actually wants:
 * finishing beats progress, free beats cheap, and an observation about your
 * duplicates — however large the number — is not a next move.
 */
const BAND = {
  /** Three cards or fewer from a finished set. */
  finish: 10_000,
  /** Cards obtainable without spending: trades, and time-sensitive price drops. */
  free: 3_000,
  /** Spend money, gain completion. */
  progress: 1_000,
  /** Useful to know, but not an action that advances a set. */
  informational: 200,
} as const;

/** Default spend ceiling for a bundle suggestion when no budget is set. */
export const DEFAULT_BUNDLE_BUDGET_CENTS = 5000;

/**
 * The largest set of cheapest missing cards affordable within `budget`.
 *
 * Greedy-cheapest-first is optimal here: every card contributes an identical
 * amount of completion (one slot), so maximising card count per dollar is
 * exactly maximising completion per dollar.
 */
export function affordablePrefix(
  missing: Requirement[],
  budgetCents: number,
): { picked: Requirement[]; costCents: number } {
  const priced = missing
    .filter((m): m is Requirement & { acquisitionCents: number } => m.acquisitionCents !== null)
    .sort((a, b) => a.acquisitionCents - b.acquisitionCents);

  const picked: Requirement[] = [];
  let cost = 0;
  for (const m of priced) {
    if (cost + m.acquisitionCents > budgetCents) break;
    picked.push(m);
    cost += m.acquisitionCents;
  }
  return { picked, costCents: cost };
}

function evidenceFrom(reqs: Requirement[], limit = 8): MoveEvidence[] {
  return reqs.slice(0, limit).map((r) => ({
    cardId: r.cardId,
    name: r.name,
    number: r.number,
    variant: r.variant,
    imageSmall: r.imageSmall,
    cents: r.acquisitionCents ?? r.marketCents,
  }));
}

export function computeMoves(ctx: MoveContext): Move[] {
  const moves: Move[] = [];
  const budget = ctx.budgetCents ?? DEFAULT_BUNDLE_BUDGET_CENTS;

  for (const g of ctx.goals) {
    const m = g.metrics;
    if (m.requiredCount === 0 || m.missingCount === 0) continue;
    const pointOf = 100 / m.requiredCount;

    // --- Within arm's reach of a finished set ------------------------------
    if (m.missingCount <= 3) {
      const cost = m.missing.reduce((s, r) => s + (r.acquisitionCents ?? 0), 0);
      const unpriced = m.missing.filter((r) => r.acquisitionCents === null).length;
      moves.push({
        kind: 'finish_line',
        goalId: g.goalId,
        setId: g.setId,
        setName: g.setName,
        mode: g.mode,
        headline:
          m.missingCount === 1
            ? `One card from finishing ${g.setName}`
            : `${m.missingCount} cards from finishing ${g.setName}`,
        detail: unpriced
          ? `${money(cost)} covers the ${m.missingCount - unpriced} with listings. ${unpriced} ${
              unpriced === 1 ? 'has' : 'have'
            } no current listing.`
          : `Approximately ${money(cost)} finishes the set.`,
        costCents: cost || null,
        deltaPoints: m.missingCount * pointOf,
        score: BAND.finish - m.missingCount * 100 + m.percent * 50,
        evidence: evidenceFrom(m.missing),
        basis: 'Lowest current listed price per card, TCGplayer.',
        confidence: unpriced ? 'estimated' : 'measured',
      });
      continue;
    }

    // --- Most completion per dollar inside the budget ----------------------
    const { picked, costCents } = affordablePrefix(m.missing, budget);
    if (picked.length >= 2 && costCents > 0) {
      const deltaPoints = picked.length * pointOf;
      const newPercent = m.percent + deltaPoints / 100;
      moves.push({
        kind: 'cheap_bundle',
        goalId: g.goalId,
        setId: g.setId,
        setName: g.setName,
        mode: g.mode,
        headline: `${picked.length} of your missing ${g.setName} cards cost about ${money(costCents)}`,
        detail: `That moves you from ${(m.percent * 100).toFixed(1)}% to about ${(newPercent * 100).toFixed(1)}% complete.`,
        costCents,
        deltaPoints,
        score:
          BAND.progress +
          Math.min(600, (deltaPoints / (costCents / 100)) * 60) +
          m.percent * 300,
        evidence: evidenceFrom(picked),
        basis: 'Cheapest available listings for cards you are missing, TCGplayer.',
        confidence: 'measured',
      });
    }

    // --- Bulk commons: the unglamorous half of every set -------------------
    const nearlyFree = m.missing.filter(
      (r) => r.acquisitionCents !== null && r.acquisitionCents <= 50,
    );
    if (nearlyFree.length >= 5) {
      const cost = nearlyFree.reduce((s, r) => s + (r.acquisitionCents ?? 0), 0);
      moves.push({
        kind: 'bulk_fill',
        goalId: g.goalId,
        setId: g.setId,
        setName: g.setName,
        mode: g.mode,
        headline: `${nearlyFree.length} ${g.setName} cards are under 50¢ each`,
        detail: `${money(cost)} clears ${nearlyFree.length} slots — ${(nearlyFree.length * pointOf).toFixed(1)} points of completion. Worth a single bulk order or one dig through a shop's commons box.`,
        costCents: cost,
        deltaPoints: nearlyFree.length * pointOf,
        score:
          BAND.progress +
          Math.min(600, ((nearlyFree.length * pointOf) / Math.max(1, cost / 100)) * 40) +
          m.percent * 300,
        evidence: evidenceFrom(nearlyFree),
        basis: 'Cards whose lowest listing is at or below $0.50.',
        confidence: 'measured',
      });
    }
  }

  // --- Duplicates as a funding source --------------------------------------
  const spare = ctx.dupes.filter((d) => d.spareCopies > 0 && d.unitValueCents !== null);
  const spareValue = spare.reduce((s, d) => s + (d.unitValueCents ?? 0) * d.spareCopies, 0);
  const topNeed = [...ctx.goals]
    .filter((g) => g.metrics.missingCount > 0)
    .sort((a, b) => b.metrics.percent - a.metrics.percent)[0];

  if (spareValue >= 1000 && topNeed) {
    const coverage = Math.min(1, spareValue / Math.max(1, topNeed.metrics.needAcquisitionCents));
    moves.push({
      kind: 'duplicate_leverage',
      setId: topNeed.setId,
      setName: topNeed.setName,
      goalId: topNeed.goalId,
      headline: `Your duplicates are worth about ${money(spareValue)}`,
      detail:
        coverage >= 1
          ? `That is more than the ${money(topNeed.metrics.needAcquisitionCents)} it would take to finish ${topNeed.setName}.`
          : `That covers roughly ${(coverage * 100).toFixed(0)}% of what is left in ${topNeed.setName}.`,
      costCents: null,
      deltaPoints: coverage * (topNeed.metrics.missingCount * (100 / topNeed.metrics.requiredCount)),
      score: BAND.informational + coverage * 300,
      evidence: [...spare]
        .sort((a, b) => (b.unitValueCents ?? 0) - (a.unitValueCents ?? 0))
        .slice(0, 6)
        .map((d) => ({
          cardId: d.cardId,
          name: d.name,
          number: d.number,
          variant: d.variant,
          imageSmall: d.imageSmall,
          cents: d.unitValueCents,
          note: `${d.spareCopies} spare`,
        })),
      basis: 'Market value of copies beyond the first, adjusted for condition.',
      confidence: 'estimated',
    });
  }

  // --- Another collector already has what you need --------------------------
  const mutual = ctx.tradeMatches.filter((t) => t.mutual);
  if (mutual.length) {
    const partners = new Set(mutual.map((t) => t.counterpartHandle));
    moves.push({
      kind: 'trade_match',
      headline: `${mutual.length} of your missing cards sit in another collector's trade binder`,
      detail: `${partners.size} collector${partners.size === 1 ? '' : 's'} ${
        partners.size === 1 ? 'has' : 'have'
      } spares you need and needs cards you hold spare. No cash required.`,
      costCents: null,
      deltaPoints: mutual.length,
      score: BAND.free + Math.min(500, mutual.length * 25),
      evidence: mutual.slice(0, 6).map((t) => ({
        cardId: t.cardId,
        name: t.name,
        number: t.number,
        variant: t.variant,
        imageSmall: t.imageSmall,
        cents: t.valueCents,
        note: `@${t.counterpartHandle}`,
      })),
      basis: 'Live match between your missing cards and copies other collectors marked for trade.',
      confidence: 'measured',
    });
  }

  // --- Real, observed price movement ---------------------------------------
  // Emitted only when two provider observations on different dates exist.
  if (ctx.priceDrops.length) {
    const drops = [...ctx.priceDrops].sort(
      (a, b) => b.previousCents - b.currentCents - (a.previousCents - a.currentCents),
    );
    const saved = drops.reduce((s, d) => s + (d.previousCents - d.currentCents), 0);
    moves.push({
      kind: 'price_drop',
      headline: `${drops.length} card${drops.length === 1 ? '' : 's'} you need dropped in price`,
      detail: `Combined, they are ${money(saved)} cheaper than the last observation on ${drops[0]!.previousOn}.`,
      costCents: drops.reduce((s, d) => s + d.currentCents, 0),
      deltaPoints: 0,
      score: BAND.free + Math.min(400, saved / 100),
      evidence: drops.slice(0, 6).map((d) => ({
        cardId: d.cardId,
        name: d.name,
        number: d.number,
        variant: d.variant,
        imageSmall: d.imageSmall,
        cents: d.currentCents,
        note: `was ${money(d.previousCents)}`,
      })),
      basis: `Change between two dated TCGplayer observations (${drops[0]!.previousOn} → ${drops[0]!.currentOn}).`,
      confidence: 'measured',
    });
  }

  if (!ctx.goals.length) {
    moves.push({
      kind: 'start_tracking',
      headline: 'Pick a set to chase',
      detail:
        'SetValue can only tell you what you NEED once it knows what you are trying to finish. Track a set and the number appears immediately.',
      costCents: null,
      deltaPoints: 0,
      score: 1,
      evidence: [],
      basis: 'No tracked sets yet.',
      confidence: 'measured',
    });
  }

  return moves.sort((a, b) => b.score - a.score);
}
