import type { Variant } from '../catalog/variants';

/**
 * The completion engine — the part of SetValue that has to be right.
 *
 * Everything here is a pure function over plain data so it can be tested
 * exhaustively without a database. The repository layer's only job is to hand
 * these functions accurate rows.
 *
 * The arithmetic identity the whole product rests on:
 *
 *     COMPLETE = HAVE + NEED
 *
 * For that to hold, HAVE and NEED must be measured the same way, so both are
 * market value in USD. NEED answers "what is the rest of this set worth?".
 * A separate figure, `needAcquisitionCents`, answers the different question
 * "what would it cost me to go buy it today?" using lowest listed prices. They
 * are never mixed into one number, and the UI labels which is which.
 */

export type GoalMode = 'main' | 'complete' | 'master';

export const GOAL_MODES: { id: GoalMode; label: string; blurb: string }[] = [
  { id: 'main', label: 'Main Set', blurb: 'Numbered cards up to the printed total, one printing each.' },
  { id: 'complete', label: 'Complete Set', blurb: 'Every card in the set including secret rares.' },
  { id: 'master', label: 'Master Set', blurb: 'Every card in every printing — reverse holos included.' },
];

/** One (card, printing) slot a goal requires. */
export interface Requirement {
  cardId: string;
  variant: Variant;
  number: string;
  numberSort: number;
  name: string;
  rarity: string | null;
  imageSmall: string | null;
  isSecret: boolean;
  /** Market value, USD cents. null = no market coverage for this printing. */
  marketCents: number | null;
  /** Lowest credible listed price, USD cents. */
  acquisitionCents: number | null;
  basis: 'market' | 'mid' | 'low' | 'high' | null;
  observedOn: string | null;
  variantSource: 'market_data' | 'inferred';
}

export interface OwnedSlot {
  cardId: string;
  variant: Variant;
  quantity: number;
}

export interface GoalMetrics {
  mode: GoalMode;
  requiredCount: number;
  ownedCount: number;
  missingCount: number;
  /** ownedCount / requiredCount, 0..1 */
  percent: number;

  haveCents: number;
  needCents: number;
  completeCents: number;

  /** Estimated cash to acquire everything missing at lowest listed prices. */
  needAcquisitionCents: number;

  /** Coverage — the numbers behind the numbers. */
  pricedOwned: number;
  unpricedOwned: number;
  pricedMissing: number;
  unpricedMissing: number;
  /** true when at least one missing card has no price, making NEED a floor. */
  needIsFloor: boolean;
  /** Oldest provider observation date contributing to these totals. */
  oldestObservation: string | null;
  /** Share of required slots whose printing came from market data, not inference. */
  variantConfidence: number;

  missing: Requirement[];
  owned: Requirement[];
}

const slotKey = (cardId: string, variant: string) => `${cardId}::${variant}`;

export function ownedIndex(slots: OwnedSlot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (s.quantity <= 0) continue;
    m.set(slotKey(s.cardId, s.variant), (m.get(slotKey(s.cardId, s.variant)) ?? 0) + s.quantity);
  }
  return m;
}

export function computeGoal(
  mode: GoalMode,
  requirements: Requirement[],
  owned: Map<string, number>,
): GoalMetrics {
  const ownedReqs: Requirement[] = [];
  const missingReqs: Requirement[] = [];

  for (const r of requirements) {
    if ((owned.get(slotKey(r.cardId, r.variant)) ?? 0) > 0) ownedReqs.push(r);
    else missingReqs.push(r);
  }

  let haveCents = 0;
  let needCents = 0;
  let needAcq = 0;
  let pricedOwned = 0;
  let pricedMissing = 0;
  let oldest: string | null = null;
  let marketVariants = 0;

  const note = (r: Requirement) => {
    if (r.observedOn && (oldest === null || r.observedOn < oldest)) oldest = r.observedOn;
    if (r.variantSource === 'market_data') marketVariants++;
  };

  for (const r of ownedReqs) {
    note(r);
    if (r.marketCents !== null) {
      haveCents += r.marketCents;
      pricedOwned++;
    }
  }
  for (const r of missingReqs) {
    note(r);
    if (r.marketCents !== null) {
      needCents += r.marketCents;
      pricedMissing++;
    }
    if (r.acquisitionCents !== null) needAcq += r.acquisitionCents;
  }

  const requiredCount = requirements.length;

  return {
    mode,
    requiredCount,
    ownedCount: ownedReqs.length,
    missingCount: missingReqs.length,
    percent: requiredCount === 0 ? 0 : ownedReqs.length / requiredCount,
    haveCents,
    needCents,
    completeCents: haveCents + needCents,
    needAcquisitionCents: needAcq,
    pricedOwned,
    unpricedOwned: ownedReqs.length - pricedOwned,
    pricedMissing,
    unpricedMissing: missingReqs.length - pricedMissing,
    needIsFloor: missingReqs.length - pricedMissing > 0,
    oldestObservation: oldest,
    variantConfidence: requiredCount === 0 ? 1 : marketVariants / requiredCount,
    missing: missingReqs,
    owned: ownedReqs,
  };
}

/**
 * Filters the full (card, printing) list of a set down to what a goal mode
 * actually asks for.
 *
 * `printedTotal` is the number on the card ("4/102"). Anything numbered above
 * it is a secret rare, which main-set collectors deliberately exclude.
 */
export function requirementsForMode(
  all: Requirement[],
  mode: GoalMode,
  primaryByCard: Map<string, Variant>,
): Requirement[] {
  switch (mode) {
    case 'master':
      return all;
    case 'complete':
      return all.filter((r) => primaryByCard.get(r.cardId) === r.variant);
    case 'main':
      return all.filter((r) => !r.isSecret && primaryByCard.get(r.cardId) === r.variant);
  }
}

// ------------------------------------------------------------- milestones ---

export type MilestoneKind =
  | 'started' | 'pct25' | 'pct50' | 'pct75' | 'pct90' | 'final_five'
  | 'one_left' | 'complete';

export const MILESTONE_COPY: Record<MilestoneKind, { title: string; body: string }> = {
  started: { title: 'The hunt begins', body: 'First card logged toward this set.' },
  pct25: { title: 'A quarter in', body: '25% of this set is yours.' },
  pct50: { title: 'Halfway', body: 'Half the set is done.' },
  pct75: { title: 'Three quarters', body: 'The finish line is in sight.' },
  pct90: { title: '90%', body: 'Ten percent stands between you and a finished set.' },
  final_five: { title: 'Final five', body: 'Five cards left. Every one counts now.' },
  one_left: { title: 'One left', body: 'A single card stands between you and a complete set.' },
  complete: { title: 'Set complete', body: 'You finished it. Every card, accounted for.' },
};

/**
 * Which milestones a goal has reached at this instant. Order matters.
 *
 * The proximity milestones ("final five", "one left") mean *you have worked
 * down to this*, so they require progress and a set big enough for the count to
 * mean anything. Without those guards, tracking the five-card Futsal Collection
 * fired "Final five — every one counts now" before the collector owned a single
 * card, which is exactly the hollow celebration that teaches people to ignore
 * the one that matters.
 */
export function milestonesFor(m: GoalMetrics): MilestoneKind[] {
  const hit: MilestoneKind[] = [];
  if (m.ownedCount > 0) hit.push('started');
  if (m.percent >= 0.25) hit.push('pct25');
  if (m.percent >= 0.5) hit.push('pct50');
  if (m.percent >= 0.75) hit.push('pct75');
  if (m.percent >= 0.9) hit.push('pct90');
  if (m.ownedCount > 0 && m.requiredCount > 5 && m.missingCount > 0 && m.missingCount <= 5) {
    hit.push('final_five');
  }
  if (m.ownedCount > 0 && m.requiredCount > 1 && m.missingCount === 1) hit.push('one_left');
  if (m.requiredCount > 0 && m.missingCount === 0) hit.push('complete');
  return hit;
}
