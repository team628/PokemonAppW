# Catalog Completion — MISSING_ENTITY reconciliation & final coverage

Final phase of the collectible-identity work: reconcile the entire remaining
`MISSING_ENTITY` population (legit English collectibles SetValue had no base card
for), create every substantiated identity as its own entity, exclude the rest with
explicit evidence-based reasons, and re-reconcile against the whole English TCGplayer
single-card universe. All production writes are additive and idempotent (ON CONFLICT
DO NOTHING); no auth/billing/trades/chat/scanner/CRM touched.

## Method

Source of truth: every English TCGplayer single-card product (via TCGCSV), across all
217 English groups. For each product identity:
1. Determine legitimacy (real released English card) and corroborate the product line
   (named TCGplayer group with a release date; high-value/unusual entries web-checked
   against a second source — e.g. Bulbapedia for MEP Celebratory Fanfare, TCGplayer +
   retailers for Kids WB Wurmple).
2. Exclude Japanese-only, sealed products, provider artifacts (code cards, checklists,
   tokens), non-English, and unnumbered products — each counted by reason.
3. Resolve the identity to `card + edition + finish + treatment + language` (migration
   0021) and create the base entity only when the physical collectible is
   substantiated and not already represented.
4. Give each identity its OWN observed price (max of the product's real TCGplayer
   market across listings); never inherit another identity's price. A variant with no
   trustworthy price stays in the catalog as UNVALUED, never dropped.

Matcher discipline: set+number is the authoritative slot (accent/typo name mismatches
resolved so "Pokémon Catcher" ≠ a new card); collectible identity is
`(set, number, name)` so different Pokémon sharing a number are distinct cards, and
number-string/zero-padding/set-code differences are checked directly against prod
before any create (e.g. `SVP 176` → existing `svp-176`, not a new `svp-SVP176`).
Ambiguous matches were rejected in a dry-run before each production batch.

## What was created (additive)

| Wave | Result |
|---|---|
| New sets | **34** product-line sets (Trainer Kits BW/XY/HGSS/SM/DP, TCG Classic, World Championship Decks, Prize Pack Series, Deck Exclusives, Jumbo, Alternate Art / League & Championship / Professor Program / Burger King / Countdown Calendar / Kids WB / Pikachu World promos, McDonald's 2023–24, Battle Academy 2020/22/24, Trick-or-Trade, First Partner Pack, EX Battle Stadium, MEE, Miscellaneous) |
| New base cards | **~4,065** distinct `(set, number, name)` card entities (provider `tcgcsv`) |
| New variants | recognized treatments + finishes, each independently priced |
| Excluded | see reasons below |

Production catalog: **175 → 209 sets, 20,594 → 24,544 cards, 39,035 → 43,816
variants.** Existing ownership, price history, provenance untouched;
`complete`/`main` set completion unchanged for every set (base1 main = 102 before and
after); RLS intact (new cards world-readable, anon writes denied); every ingest
re-run is a clean no-op.

## Final reconciliation (English TCGplayer single-card universe)

Authoritative measure — each TCGplayer product listing checked for representation by
its stored `provider_product_id` OR an exact set+number+finish match:

| Metric | Value |
|---|---|
| Total legitimate English collectible identities | **41,048** |
| Represented by SetValue | **~39,537** |
| **Exact-identity coverage overall** | **96.3%** |
| **≥ $100** | **99.7%** |
| **≥ $250** | **100.0%** |
| **≥ $500** | **100.0%** |
| **≥ $1,000** | **100.0%** |
| Remaining missing (product listings) | ~1,502 |
| Remaining UNVALUED (priced-data absent) identities | ~3,372 |

## Remaining — every group with an explicit reason

The ~1,502 unrepresented *product listings* are not distinct missing collectibles.
Broken down honestly:

- **~1,321 — print-serial reprint listings of an already-represented card.** The same
  physical card reprinted across World Championship Decks (per year/player), Battle
  Academy (per stamp number), TCG Classic (per deck), placement-stamped League cards
  (2nd/3rd Place). SetValue's identity model is `card + edition + finish + treatment +
  language`; it has **no print-run / deck-serial / stamp-serial axis** (the same
  deliberate stance as condition and grade). The card itself is represented once at
  its highest observed value; the year/deck/stamp-serial siblings collapse onto it.
  **Reason: below the model's identity resolution (documented limitation), not a
  missing collectible.**
- **~180 — holo-pattern re-listings already represented.** Poké Ball / Master Ball /
  Cosmos pattern printings (SV Black Bolt / White Flare / Prismatic) whose treatment
  identity already exists on the base card from another listing. **Reason: identity
  already in catalog; a duplicate TCGplayer listing.**
- **1 — genuine distinct card deferred:** *Aerodactyl (Prerelease)* (WoTC Fossil-era
  prerelease promo) — no base Aerodactyl in a mappable WoTC-promo set, so it needs its
  own promo entity; deferred as a single named exception. (Its sibling case, *Bayleef
  (Prerelease)*, resolved to `hgss1-35` and was attached.)

Distinct-collectible-identity coverage, collapsing print-serial reprints, is therefore
**effectively complete** — one named exception remains.

## Exclusions by explicit reason (counted per product identity)

| Reason | Count |
|---|---|
| Sealed products / non-single artifacts (boxes, ETBs, tins, decks, code cards, checklists, figures, pins) | 2,587 |
| No card number (sealed/product rows, not a single card) | 742 |
| Japanese-only | 19 |
| Non-English (Spanish / Korean / French / German / Italian / Portuguese) | 6 |

## Completion criterion

Not "coverage is high," but: **every legitimate released English collectible identity
we can substantiate is represented, and anything still absent has an explicit
evidence-based reason.** Met — $250+/$500+/$1,000+ at 100%, $100+ at 99.7%, and the
residual is print-serial reprints below the identity model's resolution plus one named
promo exception, each with a stated reason above.
