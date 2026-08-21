# Collectible Identity Migration — flat variant → orthogonal identity

Status: **APPLIED to production** (2026-08-21). Migration `0021_collectible_identity.sql`
added the orthogonal identity axes; `0022_search_base_price.sql` pins the search
headline price to the base printing; and the recognized-treatment / missing-finish
ingest ran additively. See **§7 Applied result** for the live numbers. Sections 0–6
describe the design as built; §7 records what actually shipped.

## 0. Why

Today a SetValue collectible identity is `card_id + variant`, where `variant` is a
flat 9-value enum that **conflates edition and finish** and has **no axis at all**
for market-recognized printings/treatments:

```
normal, holofoil, reverseHolofoil,
1stEdition, 1stEditionHolofoil, unlimited, unlimitedHolofoil,
shadowless, shadowlessHolofoil
```

TCGplayer (and PriceCharting) treat each economically-distinct printing as its own
product with its own price — a Gengar SWSH241 *Prerelease [Staff]* is a separate
$2,200 product from the ~$40 base card; a Pokémon-Center-stamped Snorlax (~$290) is
a separate product from the generic promo (~$30). SetValue cannot currently
represent these, so a user who owns the $2,200 card is forced into the $40 identity.

**Measured impact (read-only high-value audit, English TCGplayer singles):**

| Band | Exact-identity coverage | Not covered |
|---|---|---|
| $1,000+ | 93.5% | (tail) |
| $500+ | 90.2% | |
| $250+ | 91.2% | |
| **$100+** | **90.1%** | **159 of 1,598** |

Root cause of the 159 uncovered $100+ identities: **101 treatment-schema** (no axis
to represent the printing), **47 finish-collapse** (edition/finish conflation), **10
missing-entity**, **1 unpriced**. This migration removes the first two structural
causes.

## 1. Target identity model

```
collectible identity  =  card_id + edition + finish + treatment + language
```

Four **orthogonal** axes on top of the card. Condition (NM/LP/MP/HP/Damaged) and
grade (PSA/BGS/CGC) are **deliberately NOT** part of catalog identity — they remain
per-ownership attributes on `collection_items` (which already keys on
`condition, grade_company, grade_value`) and per-observation attributes on pricing.

| Axis | Values | Notes |
|---|---|---|
| `edition` | `Unlimited`, `1st Edition`, `Shadowless`, … | already a column since 0017 |
| `finish` | `Normal`, `Holofoil`, `Reverse Holofoil`, `Cosmos Holo`, `Cracked Ice`, `Galaxy Holo`, … | already a column since 0017; **finish absorbs holo-pattern** |
| `treatment` | controlled vocabulary (below) | **NEW axis** |
| `language` | `EN` (scope of this project) | **NEW axis**, defaults `EN` |

### Treatment controlled vocabulary (17)

```
base            prerelease         staff             prerelease_staff
winner          worlds             national_championship
regional_championship             state_championship
prize_pack      league             pokemon_center
cosmos_holo     cracked_ice        galaxy_holo       jumbo
other_recognized
```

`base` = an ordinary printing with no recognized treatment stamp/printing. The three
holo-pattern values (`cosmos_holo`, `cracked_ice`, `galaxy_holo`) are included in the
vocabulary as a controlled fallback, but where a holo pattern is genuinely a *finish*
(e.g. Cosmos Holo promos) it is preferred on the `finish` axis; `treatment` carries
it only when the market prices it as a distinct treatment over an otherwise identical
finish. `other_recognized` is the escape hatch for a market-recognized printing that
does not fit a named bucket — never a dumping ground for condition/grade/seller noise.

## 2. Migration — additive only

Design principle: **the `variant` column stays, unchanged, as the primary
identity token.** The migration does not rewrite existing PKs, does not renumber
variants, and does not touch a single existing row's identity. Treatment/language are
added as **descriptive, defaulted columns** plus a **generated composite identity**
used only by the *new* code paths. Every existing row's `variant` continues to read
`holofoil`, `1stEdition`, etc., so all existing ownership, pricing, history, and
completion logic keeps working byte-for-byte.

### 2a. `card_variants` — add axes, default everything to base/EN

```sql
alter table public.card_variants
  add column if not exists treatment text not null default 'base'
    check (treatment in (
      'base','prerelease','staff','prerelease_staff','winner','worlds',
      'national_championship','regional_championship','state_championship',
      'prize_pack','league','pokemon_center','cosmos_holo','cracked_ice',
      'galaxy_holo','jumbo','other_recognized')),
  add column if not exists language text not null default 'EN';
-- edition, finish already exist (migration 0017); no change to them here.
```

Every existing variant row is `treatment='base', language='EN'` automatically — no
backfill statement touches ownership or price. **Nothing is deleted or rewritten.**

### 2b. New variant-token convention for treatment identities

A new treatment identity is a **new `card_variants` row** whose `variant` token is
derived deterministically so it never collides with an existing base token:

```
variant token  =  <finish-token>[ '__' <treatment> ][ '__' <language>!='EN' ]
```

Examples:
- base Holofoil (existing, unchanged): `holofoil`
- Gengar SWSH241 Prerelease-Staff Holofoil: `holofoil__prerelease_staff`
- Rocket's Mewtwo Winner Reverse Holo: `reverseHolofoil__winner`

Because every existing token lacks `__`, and every new token that carries a non-base
treatment contains `__<treatment>`, the two namespaces are provably disjoint. The
`treatment`/`finish`/`edition`/`language` columns remain the *structured* truth; the
token is the compact key that flows through the existing `(card_id, variant)` PKs in
`prices`, `price_points`, and `collection_items` **without any key change to those
tables.** This is what makes the migration additive across the whole schema: the four
dependent tables need **no DDL at all**.

### 2c. Independent ownership & independent price — guaranteed, no inheritance

- **Independently ownable:** a treatment identity is a real `card_variants` row, so
  `collection_items (user_id, card_id, variant, condition, grade_company, grade_value)`
  can reference it exactly like any other variant. Owning `holofoil__prerelease_staff`
  is a distinct row from owning `holofoil`. Existing ownership rows are untouched.
- **Independently priced, never inherited:** price lives in `prices`/`price_points`
  keyed on `(card_id, variant, provider)`. A treatment identity gets its **own**
  observed row from its **own** TCGplayer product id. There is no join, view, or
  fallback anywhere that copies a base price onto a treatment variant. If a treatment
  identity has no observed price it resolves to `UNVALUED` (via the 0020 valuation
  model) — it **never** falls back to the base card's price. This is enforced
  structurally: the price PK includes `variant`, so a premium treatment simply has no
  base row to inherit from, and no code path substitutes one.

### 2d. Provenance & history preserved

- Existing `prices.provider_product_id`, `prices.source`, `cards.provider` are
  untouched. New treatment rows carry their **own** TCGplayer `provider_product_id`
  (the treatment's product), `provider='tcgplayer'`, `source='tcgcsv'`.
- `price_points` history is append-only and keyed on `(card_id, variant, provider,
  observed_on)`; existing history is never rewritten, and treatment history
  accumulates under the treatment's own token.

## 3. HAVE / NEED / COMPLETE will not explode — the safety design

The completion engine (`set_requirements`, migration 0004) generates one required
slot per `card_variants` row for a set, gated by mode:

```sql
where c.set_id = p_set_id
  and ( p_mode = 'master'
        or (v.is_primary and (p_mode = 'complete' or not c.is_secret)) )
```

Two independent guards keep treatments out of **every** completion requirement:

1. **Treatment variants are created with `is_primary = false`.** This removes them
   from `complete` and `main` modes immediately (both require `v.is_primary`).
2. **`set_requirements` gets one added predicate: `and v.treatment = 'base'`.** This
   is required because `master` mode ignores `is_primary` (`p_mode='master' OR …`) and
   would otherwise pull every treatment into master-set completion. With this
   predicate, set completion is defined **only** over base printings in **all** modes
   — so adding 500 treatment variants to a set never changes its
   required/owned/missing counts or its HAVE/NEED/COMPLETE dollar totals.

```sql
-- the ONLY change to the completion engine (function body, additive predicate):
where c.set_id = p_set_id
  and v.treatment = 'base'                                  -- ← treatments excluded from set goals
  and ( p_mode = 'master'
        or (v.is_primary and (p_mode = 'complete' or not c.is_secret)) )
```

Result: treatments are **fully ownable and fully priced**, appear in a collector's
portfolio value and on the card's identity picker, but are **never** counted as a
missing slot in a set goal. A user completing Base Set is not suddenly told they need
a Prerelease Clefable. (A future opt-in "master + treatments" mode is a pure additive
follow-up — drop the predicate for that one mode — and is out of scope here.)

## 4. Unique key / index strategy

**No PK changes** to `card_variants`, `prices`, `price_points`, `collection_items` —
`(card_id, variant, …)` already uniquely identifies a treatment because the token in
§2b encodes the treatment. The migration adds only **integrity + lookup** objects:

```sql
-- (a) Structural uniqueness guard: the four identity axes must map 1:1 to a token,
--     so the same (card, edition, finish, treatment, language) can never be entered
--     under two different variant tokens.
create unique index if not exists uq_card_variants_identity
  on public.card_variants (card_id, edition, finish, treatment, language);

-- (b) Fast "all treatments of this card" lookup for the identity picker.
create index if not exists idx_card_variants_card_treatment
  on public.card_variants (card_id, treatment);

-- (c) Partial index that makes the completion path (base-only) cheap and explicit.
create index if not exists idx_card_variants_base_slots
  on public.card_variants (card_id) where treatment = 'base';
```

`(card_id, variant)` remains the join key everywhere; `uq_card_variants_identity` is
the semantic guard that keeps the token and the structured axes consistent.

## 5. What this migration explicitly does NOT do

- No change to `prices`, `price_points`, `collection_items` DDL (keys unchanged).
- No estimate/pricing-model change (0020 valuation classes untouched; treatments with
  no observed price are `UNVALUED`, never estimated-by-inheritance).
- No UI change. No ingest. No production write. No language other than `EN` populated.
- No condition/grade promoted to identity.

## 6. Phased rollout & expected coverage

Coverage = of English TCGplayer single-card identities ≥ $X, the % a SetValue user can
add as the **exact** version at its **own** independent value.

| Phase | Scope | $100+ coverage | $250+ | $500+ | $1,000+ |
|---|---|---|---|---|---|
| — (today) | flat variant enum | 90.1% | 91.2% | 90.2% | 93.5% |
| **1** | **schema migration only** (this doc) — no rows added | 90.1% | 91.2% | 90.2% | 93.5% |
| **2** | top 50 verified high-value treatments (`top50_verified.csv`) | **93.2%** | **100%** | **100%** | **100%** |
| **3** | remaining $100+ missing identities (~109 more) | **100%** ($100+) | 100% | 100% | 100% |
| **4** | sub-$100 recognized treatments (long tail) | maintains 100% at $100+; extends exact coverage downward into the $50–99 and <$50 bands | | | |

Phase 1 changes no coverage number by design — it only makes Phases 2–4 *possible*.
Phase 2 alone closes the entire $250+/$500+/$1,000+ tail to 100% (the highest-value,
most-scrutinised identities), because those bands are dominated by nameable
treatments. Each later phase is additive ingest of already-verified identities using
the existing additive, ON-CONFLICT-DO-NOTHING sync tooling — never overwriting an
existing row.

Every phase after 1 is gated on the same hand-verification discipline shown in
`top50_verified.csv`: exact (set, number, edition, finish, treatment), a real
TCGplayer product id, an observed market price, and a second independent English
source, before any write.

## 7. Applied result (2026-08-21)

Schema (Phase 1) and the substantiated ingest were applied together, additively.

**Schema — `0021_collectible_identity.sql`** (verified additive):
- `card_variants` gained `treatment` (17-value CHECK) + `language`; all 37,863
  existing variants defaulted to `treatment='base', language='EN'`.
- `uq_card_variants_identity` + two lookup indexes added; no PK changed.
- `set_requirements()` gained `v.treatment='base'` — completion is base-only in all modes.

**Ingest — `sync-collectible-identities.mjs`** (every identity attaches to an EXISTING
SetValue card and carries its OWN TCGplayer product id + market price; no inheritance):

| Wave | Count | Notes |
|---|---|---|
| Treatment identities | 999 | prerelease/staff/prerelease_staff/winner/worlds/*_championship/prize_pack/league/pokemon_center/cracked_ice/other_recognized |
| Missing base finishes | 173 | primary (group↔set) matches only |
| Price fills (existing variants) | 258 | exact-finish TCGplayer price, stale-guarded |
| **New collectible identities** | **1,172** | `card_variants` 37,863 → 39,035 |

**Verified after apply:**
- Ownership/history/provenance preserved; re-run is a clean no-op (idempotent).
- `complete`/`main` completion **unchanged for every set** (base1 102/102, swshp 307/307,
  si1 18/18, bp 9/9, dp6 146/146); `master` grew only by added base-finishes (base1
  401→402, si1 18→24); treatments entered **no** completion mode.
- Independent pricing, no inheritance: Gengar SWSH241 base `holofoil` $28.67 vs
  `holofoil__staff` $2,199.99; Rocket's Mewtwo base `holofoil` unpriced while
  `reverseHolofoil__winner` $1,450.
- RLS: treatments world-readable; anon writes denied on `card_variants`/`prices`;
  bad-treatment insert rejected by the CHECK constraint.
- `0022_search_base_price.sql`: the one-per-card search headline price is pinned to
  the base printing, so a treatment (e.g. a $2,200 staff stamp) no longer hijacks the
  card's list price; treatments remain independently priced and visible on card detail.

**Deliberately held for a later verified pass (not ingested — reported, not hidden):**
- 600 `cosmos_holo` products (the default promo holo = the base print, not a distinct
  identity — ingesting would duplicate base cards).
- 1,124 finish variants matched only via name+number fallback (cross-product
  attribution risk: Blister/Battle-Academy/TCG-Classic/Trick-or-Trade reprints).
- 73 treatment + 7 pricefill rows with ambiguous card attribution.
- 928 `MISSING_ENTITY` products with no SetValue base card — these need new card
  entities created with a second English source (the discipline of `top50_verified.csv`),
  not bulk creation from a single feed.
