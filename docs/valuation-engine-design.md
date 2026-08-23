# SetValue Valuation Engine — design, methodology & schema (DRAFT — not deployed)

Status: **design + backtest only.** No schema in this document has been applied to
production, and no estimated price is stored or displayed. This is the deliverable
that precedes any implementation approval.

## 1. Three valuation classes

Every supported collectible identity resolves to exactly one class. An estimate is
**never** stored or shown as an observed market price.

| Class | Meaning | Displayed as |
|---|---|---|
| `OBSERVED` | A trustworthy current market observation exists for this exact identity (provider market/mid/low). | `Market $180` |
| `SETVALUE_ESTIMATE` | No adequate current observation, but enough comparable evidence for a responsible modeled value. | `SetValue Estimate $180 · range $145–$220 · Confidence: Medium` |
| `UNVALUED` | Evidence insufficient even for a responsible estimate. | `Unvalued` (no number) |

Hard rule: the estimate label, range, and confidence must always render together; a
bare number is never emitted for a `SETVALUE_ESTIMATE`. The string "Market Price"
is reserved exclusively for `OBSERVED`.

## 2. Schema (draft)

Additive; mirrors the provenance discipline already in `price_observations`.

```sql
-- 2a. Resolved valuation per exact collectible identity (the value the app reads).
create table public.card_valuations (
  card_id        text not null references public.cards(id) on delete cascade,
  variant        text not null,
  valuation_class text not null check (valuation_class in ('OBSERVED','SETVALUE_ESTIMATE','UNVALUED')),
  -- OBSERVED: copied from the resolved observed price (provider/source/currency below).
  -- ESTIMATE: modeled; observed_* are null.
  value_cents        integer,           -- point value (observed market OR estimate)
  low_cents          integer,           -- estimate range low  (null when OBSERVED)
  high_cents         integer,           -- estimate range high (null when OBSERVED)
  currency           text not null default 'USD',
  -- provenance
  provider           text,              -- OBSERVED: 'tcgplayer'/'cardmarket'; ESTIMATE: null
  source             text,              -- OBSERVED: 'pokemontcg'/'tcgcsv'; ESTIMATE: 'setvalue-model'
  observation_type   text,              -- 'market' | 'sold' | 'listed'   (OBSERVED only)
  -- estimate-only provenance
  model_version      text,              -- e.g. 'sv-est-1.0.0'
  confidence         numeric,           -- 0..1 backtest-calibrated
  confidence_label   text check (confidence_label in ('Low','Medium','High')),
  factors            jsonb,             -- features that drove the estimate
  comparables        jsonb,             -- card_ids used as comparables
  -- identity discipline (never mixed): condition XOR grade, edition, finish, language, region
  condition          text,
  grading_company    text,
  grade              text,
  edition            text,
  finish             text,
  language           text not null default 'EN',
  region             text not null default 'NA',
  valued_at          timestamptz not null default now(),
  primary key (card_id, variant)
);

-- 2b. Estimate audit trail (every model run, for backtest reproducibility / drift).
create table public.valuation_estimates (
  id            bigint generated always as identity primary key,
  card_id       text not null,
  variant       text not null,
  model_version text not null,
  estimated_cents integer not null,
  low_cents     integer, high_cents integer,
  confidence    numeric, confidence_label text,
  factors       jsonb, comparables jsonb,
  estimated_at  timestamptz not null default now()
);
```

`card_valuations` is what HAVE/NEED/COMPLETE reads; `valuation_estimates` is the
immutable model log. Neither replaces `prices`/`price_observations` — observed data
continues to flow there and is the source for `OBSERVED` rows.

## 3. Never-mix invariants (enforced by identity columns above)
graded vs raw · editions · finishes · languages · currencies · asking (listed) vs
sold. Each is a column on the identity; an estimate inherits the identity of the
comparables it was built from and may only combine like-with-like.

## 4. Estimator methodology

Target: `log(tcgplayer market USD)` — a single provider + currency, never mixed.
Trained only on `OBSERVED` cards; comparables computed from the **training split
only** (leakage-safe).

Features (all objective, no hand-tuned per-Pokémon multipliers):
- **Comparable medians** (log-price), each falling back to a broader pool when sparse:
  same national-dex (the exact Pokémon) → same (set, rarity) → same (rarity, era) →
  same set → same rarity → global.
- **Structural**: era/series, rarity, supertype (Pokémon/Trainer/Energy), finish,
  `is_secret`, release age (years), in-set position (`number_sort`).
- Model: gradient-boosted trees (`HistGradientBoostingRegressor`) on the above.

Deliberately excluded: arbitrary constants like "Charizard ×2". Character/popularity
signal enters only through the *observed* comparable medians for that Pokémon, so it
is learned from the market, not asserted.

Future features (schema-ready, not yet in model): SetValue NEED-list demand, % of
collectors pursuing the card/set, trade demand, historical momentum. These require
the demand tables already in the app and are additive.

## 5. Backtest (5-fold, leakage-safe comparables) — n = 19,609 observed USD cards

| Metric | Value |
|---|---|
| Median abs % error (MdAPE) | **36.1%** |
| Mean abs % error | 59.5% |
| Within ±25% / ±50% | 36.8% / 63.3% |
| MAE / median AE | $11.67 / $0.34 |
| Log-space correlation (ranking) | **0.946** |

Segmented MdAPE: commons/set-cards **~31%**, Rare Holo 36%, **Rare Ultra 59%**,
**Promo 69%**; price bands `<$1` 29% rising to **`$500+` 64%**; Trainer 44%, Energy 48%.

## 6. Failure analysis
- **Promos** (69% MdAPE): a promo set mixes $0.25 bulk with four-figure chase cards, so
  comparable medians badly over-predict cheap promos (e.g. svp-222 predicted $7.93 vs
  $0.25 actual). Promo value is idiosyncratic (event, print run) — weak from structure.
- **High-value tail** (`$500+` 64%): sparse comparables; a single grade/hype swing
  dominates. Log-scale keeps ranking honest but dollar error is large.
- **Rare Ultra / special-illustration**: alt-art scarcity not captured by rarity label.
- **Well-predicted**: commons/uncommons/holos in modern main sets with dense same-set
  same-rarity comparables — the bulk of the catalog.

## 7. HAVE / NEED / COMPLETE — two modes
- **Market Only**: totals sum `OBSERVED` only; `ESTIMATE`/`UNVALUED` excluded and
  counted separately ("N cards unpriced").
- **SetValue Estimated**: totals may include `SETVALUE_ESTIMATE`, but the estimated
  portion is always disclosed, e.g.
  `NEED $1,842 — Observed $1,611 · SetValue estimates $231 across 7 cards`.
This prevents false precision; the completion engine already computes per-slot values,
so this is an additive breakdown, not a rewrite.

## 8. Recommendation (see chat report for the full rationale)
1. **Close coverage by observation first.** 750 of 789 unvalued cards have a real
   TCGplayer market via TCGCSV → a price-sync moves coverage to **99.8% OBSERVED**.
   No estimation required; do this before anything else.
2. **Do not deploy estimates as a broad backfill.** At 36% median error they are not
   accurate enough to expose widely, and after (1) only ~17–39 cards would need them.
3. **Keep the estimator for the new-set launch window**, gated to `Low`/`Medium`
   confidence with visible ranges, never shown as market price, and suppressed for the
   segments it fails (promos, `$500+`). That window (a set too new to be priced — the
   exact me2pt5/me3/me4/me5 situation) is the estimator's real, recurring value.
