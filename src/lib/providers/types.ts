/**
 * Card-data provider abstraction.
 *
 * SetValue reads its catalog and prices through this interface so the product
 * is not welded to one vendor. A second provider (or a replacement, if terms
 * change) means implementing this contract — nothing in the domain, the
 * database schema or the UI knows which provider produced a row beyond the
 * `provider` column that records it for provenance.
 *
 * Two rules every implementation must honour, because the product's trust
 * claims depend on them:
 *
 *   1. Report the provider's own observation timestamp. If the provider does
 *      not supply one, return null rather than substituting "now" — a fetch
 *      time is not an observation time.
 *   2. Never invent a figure. A missing price is null, not zero.
 */

export interface ProviderSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  ptcgoCode: string | null;
  /** 'YYYY/MM/DD' or 'YYYY-MM-DD' as the provider gives it. */
  releaseDate: string | null;
  symbolUrl: string | null;
  logoUrl: string | null;
  updatedAt: string | null;
}

export interface ProviderCard {
  id: string;
  setId: string;
  number: string;
  name: string;
  supertype: string | null;
  subtypes: string[];
  rarity: string | null;
  artist: string | null;
  hp: string | null;
  types: string[];
  nationalPokedexNumbers: number[];
  flavorText: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
}

export interface ProviderPriceBlock {
  low: number | null;
  mid: number | null;
  high: number | null;
  market: number | null;
  directLow: number | null;
}

export interface ProviderPriceQuote {
  cardId: string;
  tcgplayer?: {
    /** The provider's own observation date. */
    updatedAt: string | null;
    prices: Record<string, ProviderPriceBlock | null>;
  };
  cardmarket?: {
    updatedAt: string | null;
    prices: Record<string, number | null>;
  };
}

export interface CardDataProvider {
  /** Stable identifier stored on every row this provider produced. */
  readonly id: string;
  readonly displayName: string;
  /** Rough ceiling used by the hourly job to size its work slice. */
  readonly requestsPerMinute: number;

  listSets(): Promise<ProviderSet[]>;
  listCards(setId: string): Promise<ProviderCard[]>;
  listPrices(setId: string): Promise<ProviderPriceQuote[]>;
  /** Prices for specific cards, for the prioritised hourly refresh. */
  pricesForCards(cardIds: string[]): Promise<ProviderPriceQuote[]>;
}
