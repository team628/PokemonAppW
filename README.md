# SetValue

The operating system for a Pokémon card collection.

It answers the questions a collector actually has:

**What do I have? · What do I need? · What is it worth? · What should I do next? · How do I finish?**

---

## Quick start

```bash
npm install
npm run setup      # downloads the catalog + prices, builds data/setvalue.db (~5 min)
npm run seed:demo  # optional: two demo collectors with real holdings
npm run build && npm start
```

`npm run seed:demo` prints a freshly generated password for the demo accounts — it is not
stored in this repository, and the script refuses to run under `NODE_ENV=production` unless
explicitly overridden.

```bash
npm test           # 151 unit, service, parity and data-integrity tests
npm run test:e2e   # 36-check browser run against a server on :3000
npm run typecheck

# load / DoS measurements (writes to a scratch database, never data/setvalue.db)
npx tsx tests/load/generate.ts 5000
SETVALUE_DB=/tmp/setvalue-load.db npx next start -p 3100
node tests/load/measure.mjs http://localhost:3100 <sessionToken> "label"
```

---

## The number this product exists to show

```
$174.63          TO GO
151 · Master Set
92.5% complete · 27 cards remaining

HAVE  $1,890     COMPLETE  $2,065
```

`COMPLETE = HAVE + NEED`, always. The three reconcile because they are measured the
same way — TCGplayer market value in USD — so the headline figure can never drift
from the two totals beneath it.

A separate figure, "estimated cost to acquire", uses lowest current listings and
answers a different question: *what would it cost me to go buy this today?* The two
are never blended into one number.

---

## What is real, what is estimated, what is unknown

This distinction is the product. Every screen keeps it visible.

| | Meaning | How it is shown |
|---|---|---|
| **Known** | A provider quoted this printing on a stated date | Plain figure, with the date available |
| **Estimated** | Derived from listings rather than sales, or adjusted for condition | Labelled "estimate"; move cards carry `confidence: estimated` |
| **Unknown** | No provider covers this printing | Shown as `—`, excluded from totals, and NEED is labelled a **floor** |
| **Refused** | Graded cards | Held and counted toward completion, shown as "graded — not valued" |

Concretely:

- A card with no price is **not worth $0**. It is unpriced, counted separately, and
  the UI says so wherever it changes a total.
- Cardmarket figures are EUR and appear only as a secondary reference on a card.
  There is no FX feed here, and inventing a rate would quietly corrupt every USD
  total in the product.
- Played cards are discounted from Near Mint using the standard trade-in bands
  (LP 85%, MP 70%, HP 50%, DMG 30%). These are estimates and are labelled as such.
- **Price-change alerts stay switched off** until two readings of the *same*
  printing exist. One data point is not a trend. Run `npm run snapshot:prices`
  daily and change tracking switches itself on.
- **Graded cards are not valued.** A PSA 10 and a raw copy are different objects to the
  market, routinely by one or two orders of magnitude, and SetValue has no graded price
  source. Slabs are held, counted toward set completion, and reported as unvalued —
  quoting the raw price for them would be a fabricated number dressed as a real one.
- **Bulk suggestions quote card prices only.** "141 cards for $6.95" is 141 separate
  listings from up to 141 sellers; SetValue has no shipping data and will not invent a
  per-order figure, so it states the listing count instead of implying a total outlay.

---

## Data

| | |
|---|---|
| Sets | 174 (all English) |
| Cards | 20,444 |
| Printings tracked | 34,644 |
| With a current USD market price | ~88% |
| Printings inferred rather than observed | ~2% (labelled everywhere) |

**Catalog** — [PokemonTCG/pokemon-tcg-data](https://github.com/PokemonTCG/pokemon-tcg-data),
the dataset behind api.pokemontcg.io, ingested as static JSON so builds are reproducible.

**Prices** — TCGplayer (USD) and Cardmarket (EUR) via api.pokemontcg.io. Every row keeps
the provider's own `updatedAt`, so the app can always say how old a number is.

Coverage is not 100% and is not presented as though it were. Brand-new sets and promo
runs frequently have no listing yet; those printings are reported as unpriced.

### Printings are modelled, not assumed

A collector who owns "the reverse holo Bulbasaur" and a price feed quoting
`reverseHolofoil` must be talking about the same object, or every completion
percentage is fiction. So ownership is keyed by `(card, printing, condition, grade)`
and a reverse holo never silently satisfies a main-set slot.

Two rules keep the printing list honest:

1. A printing exists with `source = 'market_data'` only if a provider actually quoted
   it. Everything else is `'inferred'` from set era and rarity, and labelled.
2. **The era overrules the provider.** Reverse holos were introduced with Legendary
   Collection in May 2002. Cardmarket returns reverse-holo fields for every card
   including 1999 Base Set, and TCGplayer labels some old promo foils
   `reverseHolofoil`. Taken at face value that invents 47 phantom slots in a Base Set
   master goal. The ingest rejects them (16 listings currently) and says so.

The era gate deliberately says nothing about rarity: whether a given holo rare also had
a reverse printing varies by set, and there the provider knows better than any rule we
could write.

---

## Architecture

```
src/lib/domain/      pure functions — completion maths, Next Best Move, milestones
src/lib/pricing/     valuation policy: which figure, from where, how old
src/lib/catalog/     printing taxonomy and era rules
src/lib/repo/        SQL → domain types (the only place set pricing is assembled)
src/lib/services/    orchestration: collection, goals, insights, trade, import, hunts
src/app/             Next.js App Router — pages, server actions, JSON API
scripts/             ingest, snapshot, demo seed
tests/               unit, service (real SQLite), data-integrity, e2e (browser)
```

The completion engine is pure and takes plain data, so it is tested exhaustively
without a database. The repository layer's only job is to hand it accurate rows.

**Storage** is SQLite via `better-sqlite3`. Everything user-owned is keyed by
`user_id`, nothing is global-mutable, and all SQL lives behind the repo/service
layer — so moving to hosted Postgres means reimplementing `src/lib/db` and the
repositories, not the domain model.

**Auth** is scrypt password hashing plus opaque session tokens stored only as
SHA-256 digests, so a database leak does not hand out live sessions. No third-party
dependency.

### Scale notes

Measured, not assumed. With 5,010 collectors, 9,000 goals and 1.02M collection rows:

| | before hardening | after |
|---|---|---|
| `/partners` (public) | 15,404 ms | **160 ms** |
| `/app` (dashboard) | 8,735 ms | **499 ms** |
| `/app/trade` | 27,456 ms / 19 MB | **444 ms / 70 KB** |
| `/app/collection` (15k-card collector) | 1,523 ms / 17 MB | **170 ms / 122 KB** |
| `/signin` under 5 concurrent public requests | 78,494 ms | **7 ms** |

- **better-sqlite3 is synchronous**, so any multi-second query stalls every request on the
  process, not just its own. That is why a public page doing an O(users) aggregate was a
  denial-of-service vector rather than merely a slow page.
- The want index is **materialised** into `want_index` and rebuilt on a worker thread
  (`wantIndexWorker.mjs`) on a 5-minute staleness check. No request ever waits for it; the
  snapshot's age is displayed rather than hidden. `tests/demand-parity.test.ts` asserts the
  aggregate agrees exactly with the per-user domain engine it replaced.
- Collection and trade lists page in SQL, so payload is flat regardless of collection size.
- Bulk import defers milestone recomputation to one pass per set: 2.4 ms/row → 0.13 ms/row,
  turning a ~48 s server freeze on a 20,000-row import into ~2.7 s.
- Card art is served straight from the provider CDN rather than proxied, so the app
  server never becomes a bottleneck on a 360-card set page.
- First-load JS is 103–112 kB across every route.

### Abuse resistance

- Rate limits are stored in the database (`rate_limits`), not process memory, so a restart
  does not hand out a fresh budget and limits hold across instances. Sign-in is capped per
  account *and* per address, sign-up and bulk import per account/address.
- Card Show replay keys live in `idempotency_keys` for the same reason: an in-memory guard
  re-armed on every deploy, so a queue replayed after a restart double-counted cards.
- `x-forwarded-for` is client-controlled, so address-based limits are a speed bump against
  casual abuse, not a defence against a determined attacker with many addresses. Real
  protection belongs at the edge.

---

## The collector loop

**Discover** → set browser across all 174 sets, with what each main set costs at market.

**Collect** → one tap on a set page toggles ownership, optimistically, reconciled against
server-computed totals.

**Organise** → binder view at 4, 9 or 12 pockets, laid out the way the cards physically
sit, with the gaps visible. Printable want list for handing to a dealer.

**Value** → portfolio totals, cost basis where purchase prices were logged, duplicates
valued separately.

**Complete** → main / complete / master goals, each resolving to explicit printing slots.

**Hunt** → Card Show mode: a pull list sorted by card number for digging through a box,
one-tap FOUND IT, and a running tally of spent versus market. Finds are queued in local
storage when the hall wifi drops and replayed with idempotency keys, so a flaky
connection cannot turn one card into three.

**Trade** → duplicates matched against what other collectors are missing, with two-way
matches surfaced first.

**Share** → a public collection page showing progress and set values, and never purchase
prices, email, or anything about where cards were bought.

**Remember** → a journey timeline grouped by day, with write-once milestones. A set that
dips below 50% because a card was sold does not re-fire "Halfway" when it climbs again —
the moment happened, and re-congratulating someone for it would cheapen the one that
matters.

---

## Next Best Move

Ranked in explainable bands, so the order is stable and defensible:

| Band | Contains | Rationale |
|---|---|---|
| Finish | ≤3 cards from a complete set | Finishing beats everything |
| Free | Trades, observed price drops | Costs no money |
| Progress | Budget bundles, sub-50¢ bulk fills | Completion per dollar |
| Informational | What your duplicates are worth | Not an action |

Within a band, completion gained per dollar decides. Every move carries `evidence` —
the specific cards and dated prices behind it — and a plain-language `basis` describing
what kind of claim it is. **A move that would need data we do not have is not emitted at
all.**

---

## Importing an existing collection

`/app/import` reads CSV from the common trackers and marketplaces. Matching is
deliberately conservative, because a silently mismatched card corrupts a completion
percentage the collector will rely on for years:

- Set + card number is tried first — the only pair that identifies a card uniquely.
- A bare card name is accepted only when exactly one card in all 174 sets carries it.
- Everything else is returned as **ambiguous with its candidates**, for a human to settle.
- A row naming a printing the card does not have is imported as the card's real printing,
  and says so.
- Nothing is written until you press import, and the file is applied in one transaction.

---

## For partners

`/partners` shows live, aggregate demand: which exact printings collectors are missing
right now, ranked by how many collectors need them. It answers the question a shop
actually has — *which cards in my inventory do these collectors need?* — from want data
rather than browsing history.

Three hard limits:

- **Counts only, never identities.** A partner sees that eleven collectors need a
  printing. It never sees which collectors, or anything else about them.
- **No paid placement in recommendations.** Next Best Move ranks by completion per
  dollar. A position in it is not purchasable.
- **No inventory dressed as advice.** A partner holding a card can be shown as an option
  beside the price; it does not change what SetValue tells you to do.

The `partners` and `partner_inventory` tables exist and the demand query is live. A
production integration would be a scoped, authenticated API over the same
`demandReport` function.

---

## Known limitations

These are stated rather than papered over.

**Card image recognition is not implemented.** Identifying a card from a photo needs a
trained model or a third-party vision service, and no such model or credential is
available in this environment. Rather than ship a camera button that produces confident
nonsense, SetValue provides the fast manual path it can stand behind: in Card Show mode,
choose the set and type the number printed on the card for an exact hit. The scanner is
the one part of the collector loop that is stubbed, and it is stubbed *out*, not faked.

**Price history begins at first ingest.** Provider `updatedAt` stamps span years, but
that is one reading per card, not a series. Change detection requires two readings of
the same printing — run `npm run snapshot:prices` daily.

**No live partner inventory.** The schema, the demand query and the console are built;
no partner API keys are issued in this environment, so no real shop inventory is loaded.

**English sets only.** The catalog covers the English releases; Japanese sets are not
ingested.

**No graded price source.** Graded cards are deliberately unvalued rather than
approximated. Wiring in a graded price feed is the fix; guessing is not.

**No password reset or email verification.** Accounts are email + password only.

**Single-node SQLite.** Correct and fast for the sizes this runs at. See *Scale notes*
for what changes and where.

---

## Trust

SetValue never fakes prices, variants, scarcity, market trends, recommendations, partner
inventory, confidence, completion — or tests. Where it knows, it shows the number. Where
it estimates, it says estimate. Where it does not know, it says so and tells you what
that does to your total.

That is not a constraint on the product. It is the product.

---

SetValue is an independent tool for collectors. Not affiliated with, endorsed by, or
sponsored by The Pokémon Company, Nintendo, Creatures Inc., GAME FREAK, TCGplayer or
Cardmarket. Card images and names are property of their respective owners.
