# SetValue Multi-Source Pricing Engine — provider capabilities & access

SetValue values a card from several **independent** providers. Each is an adapter
behind one interface (`src/lib/pricing/providers/types.ts`) and can be enabled or
disabled independently (`public.price_providers.enabled`). Every observation is
stored in `public.price_observations` against an **exact collectible identity**
(`card + set + edition + finish + condition/grade + language + region + currency`)
with full provenance (`provider`, `source`, `provider_product_id`, `observed_at`,
`fetched_at`). We never merge incompatible identities, never carry a value across
editions/finishes/grades, and never fabricate a price.

Hard rules enforced everywhere:
- Unlimited pricing is never used for 1st Edition (or vice versa).
- Raw pricing is never used for graded; PSA 9 is never used for PSA 10.
- A listing/asking price is never recorded as a completed sale.
- EUR is never presented as USD; a USD value is stored only when a legitimate FX
  source is applied, and the FX provenance is recorded.
- One provider's price is never used for a different printing.

No **SetValue Consensus** algorithm exists yet; the schema is consensus-ready but
resolution stays 1:1 until enough legitimate independent data exists.

| Provider | What we want | Access status | Credential | Licensing / commercial display | Blocked? |
|---|---|---|---|---|---|
| **pokemontcg.io** | Primary catalog + card-level TCGplayer(USD)/Cardmarket(EUR) market prices | **LIVE** | `POKEMONTCG_API_KEY` (optional) | Free API; attribution appreciated. Card-level only — cannot split Base Set editions. | No |
| **TCGCSV** (TCGplayer-derived) | Edition/finish-level fallback where pokemontcg cannot distinguish printings (Base Set 1st Ed / Shadowless / Unlimited) | **LIVE (provisional)** | none | Free community mirror of TCGplayer product data. TCGplayer-origin; acceptable for private beta. **Before scaled commercial display, obtain a formal license** (TCGplayer partner) or move this tier to a paid, licensed source. | No |
| **eBay** sold/completed comps | Real completed-sale comps, especially high-end and graded singles | **DORMANT — unavailable** | `EBAY_APP_TOKEN` (Browse / Marketplace Insights API) | Governed by the eBay API License Agreement; sold-comp (Marketplace Insights) access is approval-gated. | Yes — no authorized credentials |
| **PriceCharting** | Historical pricing and graded/slab values | **DORMANT — unavailable** | `PRICECHARTING_TOKEN` | Paid subscription; commercial display permitted under their plan terms. | Yes — no paid token |
| **Cardmarket** | European market data (EUR) | **DORMANT — unavailable** | `CARDMARKET_APP_TOKEN` | Requires a registered Cardmarket app; commercial-use conditions apply. (We already store some Cardmarket EUR indirectly via pokemontcg.) | Yes — no registered app |

## Enabling a dormant provider later
1. Obtain authorized credentials and confirm the licensing permits our commercial display.
2. Put the key in the server-only secret named in the table (Supabase Edge Function secret + Vercel env). Never commit it.
3. Replace the `dormant(...)` stub in `src/lib/pricing/providers/dormant.ts` with a real adapter implementing `observe()`.
4. Flip `public.price_providers.enabled = true` and set `access_status = 'live'`.
5. Backfill emits into `price_observations`; a resolver/consensus (future) decides display.

Nothing here makes a network call to a dormant provider. Asked to observe, a
dormant adapter throws `ProviderUnavailableError` — inaccessible data is never
represented as integrated.
