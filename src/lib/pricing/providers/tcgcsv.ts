import type {
  ObserveScope,
  PriceObservation,
  PriceProvider,
  ProviderCapabilities,
} from './types';
import { ProviderUnavailableError } from './types';

/**
 * TCGCSV — a free daily mirror of TCGplayer's own product-level data.
 *
 * Used provisionally and narrowly: it is the edition/finish-level fallback for
 * the vintage printings pokemontcg.io cannot distinguish — right now, Base Set
 * 1st Edition / Shadowless / Unlimited. Every value it emits is a TCGplayer
 * market figure (USD), labelled `source: 'tcgcsv'` so provenance is never lost.
 *
 * It does NOT price a card whose TCGplayer identity is finer than our catalog's
 * (e.g. Base Set Pikachu's Red/Yellow Cheeks map to one catalog card): those
 * cells are ambiguous and are dropped, not merged.
 */

const BASE = 'https://tcgcsv.com/tcgplayer';
const POKEMON_CATEGORY = 3;

// Set → the TCGplayer groups that hold its printings, and how each
// (group, subTypeName) resolves to an exact (edition, finish, variant).
// Grounded in observed market values (e.g. Base Set Charizard: 1st Ed Holo
// ~$10k, Shadowless Holo ~$2.1k, Unlimited Holo ~$0.86k).
interface Cell { edition: string; finish: string; variant: string }
const SET_GROUPS: Record<string, { groups: number[]; map: Record<string, Cell> }> = {
  base1: {
    groups: [604, 1663],
    map: {
      '604|Holofoil': { edition: 'Unlimited', finish: 'Holofoil', variant: 'unlimitedHolofoil' },
      '604|Normal': { edition: 'Unlimited', finish: 'Normal', variant: 'unlimited' },
      '1663|1st Edition Holofoil': { edition: '1st Edition', finish: 'Holofoil', variant: '1stEditionHolofoil' },
      '1663|1st Edition': { edition: '1st Edition', finish: 'Normal', variant: '1stEdition' },
      '1663|Unlimited Holofoil': { edition: 'Shadowless', finish: 'Holofoil', variant: 'shadowlessHolofoil' },
      '1663|Unlimited': { edition: 'Shadowless', finish: 'Normal', variant: 'shadowless' },
    },
  },
};

const CAPABILITIES: ProviderCapabilities = {
  printingLevel: true,
  graded: false,
  soldComps: false,
  history: true,
  currencies: ['USD'],
  region: 'NA',
};

interface TcgProduct { productId: number; name: string; extendedData?: { name: string; value: string }[] }
interface TcgPrice { productId: number; subTypeName: string; marketPrice: number | null; lowPrice: number | null; midPrice: number | null; highPrice: number | null }

async function getResults<T>(url: string): Promise<T[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'SetValue/1.0 (pricing-integrity)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`TCGCSV ${res.status} for ${url}`);
  const body = (await res.json()) as { results?: T[] };
  return body.results ?? [];
}

function cardNumber(p: TcgProduct): number | null {
  const raw = (p.extendedData ?? []).find((e) => e.name === 'Number')?.value ?? '';
  const m = raw.match(/(\d+)\s*\/\s*\d+/);
  return m ? parseInt(m[1]!, 10) : null;
}

const cents = (n: number | null | undefined): number | null =>
  typeof n === 'number' && n > 0 ? Math.round(n * 100) : null;

export const tcgcsvProvider: PriceProvider = {
  id: 'tcgcsv',
  displayName: 'TCGCSV (TCGplayer-derived)',
  marketplace: 'tcgplayer',
  available: true,
  capabilities: CAPABILITIES,

  async observe(scope: ObserveScope): Promise<PriceObservation[]> {
    const setIds = (scope.setIds ?? []).filter((s) => SET_GROUPS[s]);
    if (!setIds.length) {
      throw new ProviderUnavailableError('tcgcsv', 'no scoped set with a known TCGplayer group mapping');
    }
    const observedAt = new Date().toISOString();
    const out: PriceObservation[] = [];

    for (const setId of setIds) {
      const cfg = SET_GROUPS[setId]!;
      // productId → card number, per group
      const numberOf = new Map<string, number>();
      for (const g of cfg.groups) {
        const products = await getResults<TcgProduct>(`${BASE}/${POKEMON_CATEGORY}/${g}/products`);
        for (const p of products) {
          const n = cardNumber(p);
          if (n != null) numberOf.set(`${g}:${p.productId}`, n);
        }
      }

      // Gather candidate observations, keyed by (card, variant) → set of productIds,
      // so an identity backed by more than one TCGplayer product is dropped as
      // ambiguous rather than merged.
      type Cand = { obs: PriceObservation; productId: number };
      const cells = new Map<string, Cand[]>();
      for (const g of cfg.groups) {
        const prices = await getResults<TcgPrice>(`${BASE}/${POKEMON_CATEGORY}/${g}/prices`);
        for (const pr of prices) {
          const cell = cfg.map[`${g}|${pr.subTypeName}`];
          if (!cell) continue; // subtype we don't map (e.g. an unmodelled finish)
          const n = numberOf.get(`${g}:${pr.productId}`);
          if (n == null) continue;
          const value = cents(pr.marketPrice);
          if (value == null) continue; // no trustworthy value → leave unpriced
          const cardId = `${setId}-${n}`;
          const key = `${cardId}|${cell.variant}`;
          const obs: PriceObservation = {
            provider: 'tcgcsv',
            source: 'tcgcsv',
            providerProductId: String(pr.productId),
            cardId,
            setId,
            variant: cell.variant,
            edition: cell.edition,
            finish: cell.finish,
            condition: 'NM', // TCGplayer market is the ungraded near-mint market
            gradingCompany: null,
            grade: null,
            language: 'EN',
            region: 'NA',
            currency: 'USD',
            observationType: 'market',
            valueCents: value,
            valueUsdCents: value, // source is already USD; no FX applied
            fxSource: null,
            lowCents: cents(pr.lowPrice),
            midCents: cents(pr.midPrice),
            highCents: cents(pr.highPrice),
            observedAt,
          };
          (cells.get(key) ?? cells.set(key, []).get(key)!).push({ obs, productId: pr.productId });
        }
      }

      for (const cands of cells.values()) {
        const distinctProducts = new Set(cands.map((c) => c.productId));
        if (distinctProducts.size === 1) {
          out.push(cands[0]!.obs); // unambiguous → emit
        }
        // else: ambiguous (multiple TCGplayer products for one catalog identity)
        // → dropped here; the backfill flags the card for manual resolution.
      }
    }
    return out;
  },
};
