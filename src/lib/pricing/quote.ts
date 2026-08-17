import type { Variant } from '../catalog/variants';

/**
 * Valuation policy.
 *
 * Every dollar SetValue shows has to be traceable to a specific provider
 * observation on a specific date. That constraint drives three rules:
 *
 *  1. **One currency per number.** Portfolio totals are USD and come from
 *     TCGplayer only. Cardmarket figures are EUR and are shown as a secondary
 *     reference on the card, never silently converted — we have no FX feed, and
 *     inventing a rate would quietly corrupt every total in the product.
 *  2. **Explicit basis.** `market` is a real transaction-derived figure. `mid`
 *     and `low` are listing-derived. Which one produced a number travels with
 *     the number so the UI can degrade the claim ("est." rather than a price).
 *  3. **Absence is a value.** A card with no quote is not worth $0; it is
 *     unpriced. Unpriced cards are counted and reported separately, which is
 *     what makes NEED a floor rather than a fiction.
 */

export type PriceBasis = 'market' | 'mid' | 'low' | 'high';
export type Provider = 'tcgplayer' | 'cardmarket';

export interface PriceRow {
  card_id: string;
  variant: string;
  provider: string;
  currency: string;
  low_cents: number | null;
  mid_cents: number | null;
  high_cents: number | null;
  market_cents: number | null;
  direct_cents: number | null;
  observed_on: string;
}

export interface PriceQuote {
  cents: number;
  currency: 'USD';
  provider: Provider;
  basis: PriceBasis;
  observedOn: string;
  /** true when `basis` is not 'market' — a listing figure, not a sale figure. */
  isEstimate: boolean;
  variant: Variant;
}

/** How stale a quote is allowed to get before the UI flags it. */
export const STALE_AFTER_DAYS = 14;

export function daysSince(isoDate: string, now = new Date()): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - then) / 86_400_000);
}

export function isStale(quote: PriceQuote, now = new Date()): boolean {
  return daysSince(quote.observedOn, now) > STALE_AFTER_DAYS;
}

/**
 * Resolve the USD quote for one printing. Returns null when the card has no
 * USD coverage at all — callers must treat that as "unknown", never as zero.
 */
export function quoteFor(rows: PriceRow[], variant: Variant): PriceQuote | null {
  const row = rows.find(
    (r) => r.variant === variant && r.provider === 'tcgplayer' && r.currency === 'USD',
  );
  if (!row) return null;

  const ladder: [PriceBasis, number | null][] = [
    ['market', row.market_cents],
    ['mid', row.mid_cents],
    ['low', row.low_cents],
  ];
  for (const [basis, cents] of ladder) {
    if (cents !== null && cents > 0) {
      return {
        cents,
        currency: 'USD',
        provider: 'tcgplayer',
        basis,
        observedOn: row.observed_on,
        isEstimate: basis !== 'market',
        variant,
      };
    }
  }
  return null;
}

/** The cheapest credible acquisition cost — what "can I buy this today?" means. */
export function acquisitionCents(rows: PriceRow[], variant: Variant): number | null {
  const row = rows.find(
    (r) => r.variant === variant && r.provider === 'tcgplayer' && r.currency === 'USD',
  );
  if (!row) return null;
  const candidates = [row.direct_cents, row.low_cents, row.market_cents, row.mid_cents].filter(
    (c): c is number => c !== null && c > 0,
  );
  return candidates.length ? Math.min(...candidates) : null;
}

export function cardmarketRef(rows: PriceRow[], variant: Variant): PriceRow | null {
  return rows.find((r) => r.variant === variant && r.provider === 'cardmarket') ?? null;
}

// ------------------------------------------------------------- formatting ---

export function money(cents: number | null | undefined, opts: { cents?: boolean } = {}): string {
  if (cents === null || cents === undefined) return '—';
  const showCents = opts.cents ?? Math.abs(cents) < 100_000;
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: showCents ? 2 : 0,
    maximumFractionDigits: showCents ? 2 : 0,
  })}`;
}

export function euros(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}
