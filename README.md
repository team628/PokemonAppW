# SetValue

The operating system for a Pokémon card collection.

It answers the questions a collector actually has:

**What do I have? · What do I need? · What is it worth? · What should I do next? · How do I finish?**

---

## Quick start

```bash
npm install
export SUPABASE_DB_URL=postgresql://…      # a Supabase project, or any PostgreSQL 15+
npm run setup       # restores the pinned provider snapshot, migrates, ingests (~1 min)
npm run seed:demo   # optional: two demo collectors with real holdings
npm run build && npm start
```

`npm run setup` works offline: `data/snapshot/` holds a capture of real provider
data — 174 sets, 20,444 cards, 66,951 prices — so a clone reproduces the exact corpus
CI validates against. `npm run setup:live` fetches from the providers instead, which is
what you want when refreshing the snapshot (`npm run snapshot:capture`).

`npm run setup` runs `npm run migrate`, which applies `supabase/migrations/*.sql` in
order. Every migration is idempotent, so it is safe to re-run. Against a hosted project
the same files go through `supabase db push`. See `supabase/README.md` for the
environment variables and the pg_cron schedule.

`npm run seed:demo` refuses to run under `NODE_ENV=production` unless explicitly
overridden. Identity comes from Supabase Auth, so the demo accounts have whatever
password you set for them there.

```bash
npm test            # 226 unit, service, parity, RLS, concurrency and integrity tests
npm run test:e2e    # 36-check browser run against a server on :3000
npm run typecheck

# load / DoS measurements
npm run load:generate -- 5000
npm run build && npx next start -p 3100
node tests/load/measure.mjs http://localhost:3100 <identityCookie> "label"
node tests/load/concurrency.mjs http://localhost:3100 <identityCookie>
```

`load:generate` writes into the configured database and clears its own
`load-*@example.test` population on each run; it does not touch other accounts.

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
  printing exist. One data point is not a trend. Run `npm run prices:refresh`
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
supabase/migrations/ the schema, the completion engine, the want index, RLS — in SQL
src/lib/db/pg.ts     the only connection code: pooling and per-request identity
src/lib/services/pg/ orchestration over those SQL functions
src/lib/domain/      pure functions — Next Best Move, milestones, the reference engine
src/lib/pricing/     money formatting and the vocabulary for how a price was derived
src/lib/catalog/     printing taxonomy and era rules, applied at ingest
src/lib/providers/   the card-data provider interface and its pokemontcg.io implementation
src/lib/billing/     Stripe, behind a flag that is off
src/app/             Next.js App Router — pages, server actions, JSON API
scripts/pg/          migrate and ingest
tests/pg/            RLS, parity, services, concurrency, demand, integrity, throughput
```

**Storage** is PostgreSQL — a Supabase project in production, plain PostgreSQL locally.
Connections go through `pg` against the Supavisor transaction pooler, which is what makes
this safe on Vercel: a serverless function that opens a direct connection per invocation
exhausts the database's connection slots under any real traffic.

**The completion engine lives in SQL** (`supabase/migrations/0004`). HAVE, NEED and
COMPLETE are summed from one per-slot value in one pass, in integer cents with `bigint`
accumulators, so `COMPLETE = HAVE + NEED` is exact by construction rather than
approximately equal. The TypeScript engine in `src/lib/domain/goals.ts` is retained as an
independent reference implementation; `tests/pg/parity.test.ts` asserts the two agree
exactly across nine set/mode combinations on the real catalog.

**Authorization is Row Level Security**, not application code. Every user-owned table is
policed by `user_id = auth.uid()`, and each request runs inside a transaction that sets
`role` and `request.jwt.claims` — the same mechanism PostgREST uses. A page that forgot a
`WHERE user_id = …` clause returns nothing rather than someone else's collection.
`tests/pg/rls.test.ts` attacks this directly: User B authenticates and queries User A's
rows at the database layer with no filter at all, bypassing every page and route handler.

The two deliberate exceptions are `public_goal_missing()` and `trade_matches()`, both
SECURITY DEFINER, both narrow, both documented at the point of definition: a shared page
needs to read the sharer's holdings, and trade matching is a cross-collector question by
definition. Each re-checks its own opt-in and projects card identity only.

**Auth** is Supabase Auth (`@supabase/ssr`): password sign-in, magic link, reset, and a
`/auth/callback` code exchange. `getUser()` revalidates the token with the auth server
rather than trusting cookie contents. A local identity provider stands in only where no
Supabase project is configured, and refuses to activate whenever `NEXT_PUBLIC_SUPABASE_URL`
is set or in production without an explicit override.

### Scale notes

Measured, not assumed. With 5,001 collectors, 9,067 goals and 979k collection rows, as a
collector holding 15,000 cards:

| | SQLite (pre-migration) | PostgreSQL |
|---|---|---|
| `/partners` (public) | 240 ms | **142 ms** |
| `/app` (dashboard) | 447 ms | **298 ms** |
| `/app/trade` | 305 ms | **268 ms** |
| `/app/collection` | 163 ms / 122 KB | **122 ms / 130 KB** |
| `/app/sets/sv3pt5?mode=master` | 62 ms | **88 ms** |
| `/app/moves` | 373 ms | **273 ms** |
| `/signin` under 5 concurrent public requests | 8 ms | **6 ms** |

The comparison is like-for-like on the same hardware and the same synthetic population.
The point is not the margin — it is that moving the completion engine into SQL and the
authorization boundary into RLS cost nothing in latency while removing the single-process
ceiling entirely.

- The want index is a **summary table maintained incrementally by triggers** on the two
  things that move the number: ownership and tracked goals. Steady-state cost is
  proportional to the change, not the user base, and no request ever waits for a rebuild.
  A materialized view was rejected because `REFRESH` takes an ACCESS EXCLUSIVE lock, which
  is the wrong shape for a table that changes on every card logged. A nightly full rebuild
  remains as reconciliation; `tests/pg/demand.test.ts` asserts the trigger-built index and
  a full recomputation agree exactly after a workload of adds, removes and goal changes.
- Collection and trade lists page in SQL, so payload is flat regardless of collection size.
- Bulk import commits in one transaction and defers milestone recomputation to one pass per
  set: measured at ~3,000 rows/s matched and ~2,100 rows/s committed against the real
  20,444-card catalog.
- Card art is served straight from the provider CDN rather than proxied, so the app
  server never becomes a bottleneck on a 360-card set page.
- First-load JS is 103–112 kB across every route.

### Continuous integration

Two lanes, because they answer different questions.

**`CI`** runs on every pull request and on pushes to `main`. It is deterministic: a
PostgreSQL 16 service container, the eleven migrations, and an ingest of the pinned
snapshot with `SETVALUE_PROVIDER_OFFLINE=1`, which turns any request that would leave
the runner into an error rather than a silent network call. Then the full 226-test
suite, a production build, a real server, the browser end-to-end run and the HTTP
concurrency harness. Nothing in it depends on a third party being healthy.

The snapshot is a capture of real provider data, not synthesized, which is why the
integrity assertions keep their meaning offline — 174 sets, 20,444 cards, >85% USD price
coverage, no reverse holos before Legendary Collection are all statements about what the
providers actually published.

**`Live provider data`** runs on a schedule and on demand. It fetches from the catalog
repository and the pokemontcg.io price API for real, ingests that, and runs the same
battery against it. This is where the snapshot going stale shows up, and where a
provider outage shows up. It is deliberately not a required PR check: the price API
returns HTTP 500 on individual sets from time to time, which is a fact about a third
party rather than a fact about a pull request.

Price ingest tolerates a set the provider cannot serve — it records the failure, finishes
the sync run as `partial`, and leaves those cards unpriced rather than guessed at. One
bad set does not discard the other 173.

Both lanes end by writing to the job summary what they did *not* verify: Supabase Auth
(no credentials, so the wrong-password check reports `BLOCKED` rather than passing),
pg_cron scheduling (absent from the stock image), the Supavisor pooler, and the
5,001-collector load harness. A green tick should not be read as more coverage than it is.

### Abuse resistance

- Rate limits are stored in the database (`rate_limits`) and incremented and read in one
  statement, so a restart does not hand out a fresh budget, the limit holds across every
  serverless instance, and twenty simultaneous callers cannot race past it. Sign-in is
  capped per account *and* per address, sign-up and bulk import per account/address.
- Card Show replay keys live in `idempotency_keys` for the same reason: an in-memory guard
  is re-armed on every deploy, so a queue replayed after a restart double-counted cards.
- Concurrent writes to one holding are settled inside a single statement, and the derived
  "this is the first copy" answer is serialised by a transaction-scoped advisory lock keyed
  on `(collector, card, printing)` — narrow enough that unrelated adds never contend.
  `tests/pg/concurrency.test.ts` fires twenty simultaneous adds and asserts exactly one
  acquisition event.
- The rate-limited render of `/partners` is an HTTP 200 carrying an interstitial rather
  than a 429, because a Next.js App Router *page* cannot set a response status. The cap
  itself holds; route handlers do return 429.
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

The demand query is live and runs through `public.demand_report()`. There is no partner
API: no partner accounts, inventory tables or API keys exist in the schema, so nothing on
that page sits behind an integration. It is the signal, shown as it stands.

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
the same printing — run `npm run prices:refresh` daily.

**No live partner inventory.** The schema, the demand query and the console are built;
no partner API keys are issued in this environment, so no real shop inventory is loaded.

**English sets only.** The catalog covers the English releases; Japanese sets are not
ingested.

**No graded price source.** Graded cards are deliberately unvalued rather than
approximated. Wiring in a graded price feed is the fix; guessing is not.

**No password reset or email verification.** Accounts are email + password only.

**Graded cards are held but never valued.** A slab and a raw copy are different objects to
the market, and no defensible graded price source is available here. Graded holdings count
toward set completion and are reported as a separate count; their value shows as
unavailable rather than borrowing the raw price.

**Payments are not live.** The Stripe integration, its tables and its webhook receiver
exist behind `SETVALUE_BILLING_ENABLED`, which is off. While it is off the webhook route
is a 404 and no code path can reach Stripe. There is no plan, no price and no upgrade
surface, because advertising something that cannot be bought is the same class of
dishonesty as quoting a price nobody quoted.

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
