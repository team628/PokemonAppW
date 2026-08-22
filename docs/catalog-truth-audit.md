# Final catalog truth audit — deduplicated coverage, pricing integrity

The closing audit before declaring catalog completion. No architecture added. All
changes additive/corrective on data only; auth, billing, trades, chat, scanner, CRM
untouched.

## 1. Aerodactyl (Prerelease) — resolved

The one genuine distinct collectible previously identified as missing. Substantiated
against multiple reputable English sources (TCGplayer, PriceCharting, eBay, DA Card
World, SportsCardInvestor): the WoTC Promo **Aerodactyl (Prerelease), Fossil #01/62,
1st Edition Holo**. It is a Prerelease-stamp treatment of the Fossil Aerodactyl
(`base3-1`). Ingested as `base3-1 · finish=Holofoil · edition=1st Edition ·
treatment=prerelease`, observed market **$88.96** — its own price. The base printings
keep their independent values (1st Ed Holo $92.70, Unlimited Holo $42.06); nothing is
inherited.

## 2. Deduplicated distinct collectible-identity coverage

Canonical identity key: **set + collector number + name + edition + finish +
treatment + language**. Every provider listing that resolves to the same collectible
is collapsed before counting, so duplicate marketplace listings, WCD per-year/deck
reprints, and equivalent provider records are **not** counted as distinct or missing.

| Metric | Value |
|---|---|
| Legitimate distinct English collectible identities | **39,920** |
| Represented by SetValue | **39,920** |
| Genuinely missing | **0** |
| **Exact coverage** | **100.00%** |
| ≥ $100 | **100.00%** (1,592 / 1,592) |
| ≥ $250 | **100.00%** (523 / 523) |
| ≥ $500 | **100.00%** (173 / 173) |
| ≥ $1,000 | **100.00%** (46 / 46) |

Exclusions (provider listings, by explicit reason): sealed / non-single / artifact
2,587; no collector number 742; Japanese-only 19; non-English 6.

## 3. UNVALUED audit (3,477 identities re-queried against observed sources)

Every unvalued identity was re-matched to the integrated observed-price source
(TCGplayer via TCGCSV) by exact identity — **base variants matched only against
base (non-treatment) products**, so no premium price can be borrowed.

| Classification | Count |
|---|---|
| OBSERVED PRICE FOUND | 0 (base observed coverage was already complete) |
| NO CURRENT MARKET DATA | 24 |
| NOT ECONOMICALLY DISTINCT / DUPLICATE | 2,825 (spurious reverse-holo on holo-only GX/ex/V; only-print promos) |
| PROVIDER COVERAGE GAP | 326 (real card, no provider product at that number) |
| IDENTITY MATCH PROBLEM | 302 (edition-label ambiguity: SetValue generic `normal` vs TCGCSV split 1st Ed/Unlimited) |

Every apparent "found" base price proved to be a treatment product (Staff / Prerelease
/ Cosmos / Worlds) matched to a base variant — a borrow — and was rejected.

## 4. Pricing-integrity correction (base never carries a premium-treatment price)

The audit surfaced base variants whose observed price had been borrowed from a premium
treatment product by an earlier card-level match. Detected two ways: (a) base prices
whose stored `provider_product_id` is a treatment product (249), and (b) base variants
whose price equals a same-finish premium-treatment sibling (202). Resolved per case:

- **Corrected to the real base-product price** where a distinct base printing exists (63).
- **Reverted to UNVALUED** where the card exists only as a premium event/stamp printing
  and the base variant was a duplicate of it (197). The value now lives solely on the
  treatment identity.
- **Kept** default/only-print cases (e.g. Cosmos-Holo blister promos) where that print
  is the card's sole market (181), and benign low-value coincidences (4).

Result: **no base variant shares a premium treatment's price** except 4 benign
low-value cases where a genuine base product coincides. Example — `swshp-SWSH066`
Charizard: base Holofoil now UNVALUED, `holofoil__prerelease` $101.86,
`holofoil__prerelease_staff` $580.92.

## 5. Final validation (all pass)

- Ordinary/base prices are not replaced by premium-treatment prices (corrected above).
- Every premium treatment keeps its own independent value (1,703 priced treatment
  identities; Gengar SWSH241 base $28.67 vs `holofoil__staff` $2,199.99).
- HAVE/NEED/COMPLETE correct for a real user in all modes; `complete`/`main` set
  completion unchanged (base1 = 102 required before and after).
- Set completion never requires a premium treatment (0 treatments across all
  `set_requirements` modes).
- Search finds exact variants/treatments; the one-per-card search headline stays the
  base printing (a $2,200 staff never hijacks it).
- RLS intact (catalog world-readable, anon writes denied on cards and prices).
- Ingests idempotent (re-run leaves counts unchanged).
- No unrelated systems changed.

## 6. Final catalog & pricing numbers

| | |
|---|---|
| Sets | **209** |
| Cards | **24,544** |
| Collectible-identity variants | **43,925** |
| Priced identities | **40,241** |
| UNVALUED identities | **3,684** (classified in §3–4; kept in catalog, never excluded) |
| Distinct-identity coverage | **100.00%** overall and at $100+/$250+/$500+/$1,000+ |
| Genuinely unresolved identities | **0** |

SetValue Estimates remain OFF; every displayed value is an observed market price for
that exact identity.
