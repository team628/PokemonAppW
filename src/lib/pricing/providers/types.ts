/**
 * The Multi-Source Pricing Engine's provider contract.
 *
 * Every pricing source — TCGplayer-derived, eBay sold comps, PriceCharting,
 * Cardmarket — is an independent adapter behind this one interface, and can be
 * enabled or disabled without touching any other. An adapter's only job is to
 * emit `PriceObservation`s: each is one observation of one EXACT collectible
 * identity, carrying full provenance. Adapters never merge identities, never
 * carry a value across editions/finishes/grades, and never fabricate a price.
 *
 * Resolution (which observation becomes a card's shown price) and any future
 * consensus live above this layer, not inside an adapter.
 */

/** How a value was witnessed. Asking prices are never completed sales. */
export type ObservationType = 'market' | 'sold' | 'listed' | 'observed';

/** One observation of one exact collectible identity. */
export interface PriceObservation {
  provider: string; // registry id, e.g. 'tcgcsv'
  /** How it was accessed — e.g. 'tcgcsv' (a TCGplayer-derived mirror). */
  source: string;
  providerProductId?: string | null;
  providerListingId?: string | null;

  // Identity — card + set + edition + finish (+ condition/grade + language/region)
  cardId: string;
  setId: string;
  variant: string; // app-level variant key (edition+finish)
  edition?: string | null; // '1st Edition' | 'Shadowless' | 'Unlimited' | 'unspecified'
  finish?: string | null; // 'Holofoil' | 'Reverse Holofoil' | 'Normal'
  condition?: string | null; // raw condition XOR grading below
  gradingCompany?: string | null; // 'PSA' | 'BGS' | 'CGC'
  grade?: string | null; // '10' | '9.5' (text — never coerce PSA9 to PSA10)
  language?: string | null; // 'EN' | 'JP'
  region?: string | null; // 'NA' | 'EU'

  currency: string; // ISO code of valueCents
  observationType: ObservationType;
  valueCents: number | null; // in `currency`; null = no trustworthy value
  valueUsdCents?: number | null; // only when a legitimate FX source exists
  fxSource?: string | null;
  lowCents?: number | null;
  midCents?: number | null;
  highCents?: number | null;

  observedAt: string; // ISO timestamp the market observation is dated
}

/** Static description of what a provider can and cannot do, and its access status. */
export interface ProviderCapabilities {
  printingLevel: boolean; // distinguishes 1st Ed / Shadowless / Unlimited etc.
  graded: boolean;
  soldComps: boolean;
  history: boolean;
  currencies: string[];
  region?: string;
}

export interface PriceProvider {
  id: string;
  displayName: string;
  marketplace: string;
  /** Whether this adapter can currently make authorized calls. */
  readonly available: boolean;
  capabilities: ProviderCapabilities;
  /**
   * Emit observations for the given scope. A dormant/unauthorized adapter must
   * throw rather than return fabricated or empty-but-implying-integrated data.
   */
  observe(scope: ObserveScope): Promise<PriceObservation[]>;
}

/** What to price. Kept minimal for the current Base-Set-scoped work. */
export interface ObserveScope {
  /** Restrict to these set ids (e.g. ['base1']). Empty = provider default. */
  setIds?: string[];
}

/** Thrown by a dormant adapter asked to do work it has no authorized access for. */
export class ProviderUnavailableError extends Error {
  constructor(providerId: string, reason: string) {
    super(`pricing provider "${providerId}" is unavailable: ${reason}`);
    this.name = 'ProviderUnavailableError';
  }
}
