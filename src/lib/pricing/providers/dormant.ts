import type { ObserveScope, PriceObservation, PriceProvider, ProviderCapabilities } from './types';
import { ProviderUnavailableError } from './types';

/**
 * Dormant provider placeholders.
 *
 * These declare the shape and capability of sources we intend to integrate but
 * cannot call yet — because we lack authorized API access. They make NO network
 * calls. Asked to observe, each throws `ProviderUnavailableError`: we never
 * represent inaccessible data as integrated, and never fabricate. When real
 * credentials exist, each is replaced by a working adapter behind the same
 * interface. See docs/pricing-providers.md for access/licensing detail.
 */

function dormant(
  id: string,
  displayName: string,
  marketplace: string,
  capabilities: ProviderCapabilities,
  reason: string,
): PriceProvider {
  return {
    id,
    displayName,
    marketplace,
    available: false,
    capabilities,
    async observe(_scope: ObserveScope): Promise<PriceObservation[]> {
      throw new ProviderUnavailableError(id, reason);
    },
  };
}

export const ebayProvider = dormant(
  'ebay',
  'eBay sold/completed comps',
  'ebay',
  { printingLevel: true, graded: true, soldComps: true, history: true, currencies: ['USD'], region: 'NA' },
  'no authorized eBay API credentials; sold-comp access is approval-gated',
);

export const pricechartingProvider = dormant(
  'pricecharting',
  'PriceCharting',
  'pricecharting',
  { printingLevel: true, graded: true, soldComps: true, history: true, currencies: ['USD'] },
  'no PriceCharting API token (paid subscription required)',
);

export const cardmarketProvider = dormant(
  'cardmarket',
  'Cardmarket (Europe)',
  'cardmarket',
  { printingLevel: true, graded: false, soldComps: false, history: true, currencies: ['EUR'], region: 'EU' },
  'no registered Cardmarket app credentials',
);
