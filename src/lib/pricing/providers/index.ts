import type { PriceProvider } from './types';
import { tcgcsvProvider } from './tcgcsv';
import { ebayProvider, pricechartingProvider, cardmarketProvider } from './dormant';

export * from './types';

/**
 * The provider registry / hierarchy.
 *
 * Ordered by priority (lower first) for the day a resolver or consensus needs
 * to choose among overlapping identities. Today the two live providers cover
 * disjoint identities (pokemontcg = card-level everywhere; tcgcsv = edition
 * level for Base Set only), so there is no contention to resolve yet.
 *
 * pokemontcg.io is the primary catalog+price provider but is ingested through
 * its own path (src/lib/providers/pokemontcg.ts + src/lib/sync/ingest.ts); it
 * is represented here for hierarchy/metadata completeness. The adapters below
 * are the observation-emitting sources of the pricing engine.
 */
export const PRICE_PROVIDERS: PriceProvider[] = [
  tcgcsvProvider,
  ebayProvider,
  pricechartingProvider,
  cardmarketProvider,
];

export function priceProvider(id: string): PriceProvider | undefined {
  return PRICE_PROVIDERS.find((p) => p.id === id);
}

/** Providers that can currently make authorized calls. */
export function livePriceProviders(): PriceProvider[] {
  return PRICE_PROVIDERS.filter((p) => p.available);
}

export { tcgcsvProvider };
