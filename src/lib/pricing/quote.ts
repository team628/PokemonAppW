/**
 * Money formatting, and the shared vocabulary for how a price was derived.
 *
 * The valuation policy these serve lives with the code that applies it:
 * `toRequirement` in src/lib/repo/catalog.ts picks the figure for a set slot,
 * and `decorate` in src/lib/services/collection.ts applies the condition
 * adjustment for a held card.
 */

export type PriceBasis = 'market' | 'mid' | 'low';

/** How stale a quote is allowed to get before the UI flags it. */
export const STALE_AFTER_DAYS = 14;

export function daysSince(isoDate: string, now = new Date()): number {
  const then = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - then) / 86_400_000);
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
