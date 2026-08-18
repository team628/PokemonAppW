import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import {
  listHoldingsPage,
  portfolioSummary,
  type HoldingsSort,
  type HoldingsView,
} from '@/lib/services/pg/collection';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { CollectionView, type CollectionPageData, type HoldingView } from '@/components/CollectionView';
import { CardTile } from '@/components/CardTile';
import { Disclosure, Money, Progress, SectionTitle } from '@/components/ui';
import { money } from '@/lib/pricing/quote';
import type { Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

const VIEWS: HoldingsView[] = ['all', 'duplicates', 'trade', 'valuable', 'graded'];
const SORTS: HoldingsSort[] = ['value', 'recent', 'name', 'set'];

export default async function CollectionPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; sort?: string; page?: string; raw?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();

  // `raw=1` turns the condition heuristic off, so a collector can see the
  // provider-backed figures with no model applied.
  const applyCondition = sp.raw !== '1';
  const browsing = !!(sp.q || sp.view || sp.page);

  const [summary, result, deck] = await Promise.all([
    portfolioSummary(user.id),
    listHoldingsPage(user.id, {
      view: VIEWS.find((v) => v === sp.view),
      sort: SORTS.find((s) => s === sp.sort),
      q: sp.q,
      page: sp.page ? Number(sp.page) : 1,
      applyCondition,
    }),
    // Two bounded aggregates for the command deck. Both group in SQL — a
    // 15,000-card collection costs the same as a 50-card one.
    withIdentity(user.id, async (tx) => {
      const sets = await tx.rows<{ set_id: string; set_name: string; cards: number; cents: number }>(
        `select c.set_id, s.name as set_name,
                sum(ci.quantity)::int as cards,
                coalesce(sum(case when coalesce(ci.grade_company,'') = ''
                  then public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) * ci.quantity end), 0)::bigint as cents
         from public.collection_items ci
         join public.cards c on c.id = ci.card_id
         join public.sets s on s.id = c.set_id
         left join public.prices p
           on p.card_id = ci.card_id and p.variant = ci.variant and p.provider = 'tcgplayer'
         group by c.set_id, s.name
         order by cents desc
         limit 6`,
      );
      const top = await tx.rows<{
        card_id: string; variant: string; number: string; name: string;
        image_small: string | null; cents: number | null;
      }>(
        `select ci.card_id, ci.variant, c.number, c.name, c.image_small,
                public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents) as cents
         from public.collection_items ci
         join public.cards c on c.id = ci.card_id
         left join public.prices p
           on p.card_id = ci.card_id and p.variant = ci.variant and p.provider = 'tcgplayer'
         where coalesce(ci.grade_company,'') = ''
         order by cents desc nulls last
         limit 12`,
      );
      return { sets, top };
    }),
  ]);

  const rows: HoldingView[] = result.rows.map((h) => ({
    id: h.id,
    cardId: h.card_id,
    variant: h.variant as Variant,
    condition: h.condition,
    quantity: h.quantity,
    paidCents: h.paid_cents,
    valueCents: h.estimatedValueCents,
    observedMarketCents: h.observedMarketCents,
    conditionAdjusted: h.conditionAdjusted,
    conditionMultiplier: h.conditionMultiplier,
    forTrade: h.for_trade,
    isGraded: h.isGraded,
    gradeLabel: h.isGraded ? `${h.grade_company} ${h.grade_value ?? ''}`.trim() : null,
    unvaluedReason: h.unvaluedReason,
    name: h.name,
    number: h.number,
    imageSmall: h.image_small,
    setName: h.set_name,
  }));

  const data: CollectionPageData = {
    rows,
    total: result.total,
    page: result.page,
    pageCount: result.pageCount,
    totalCards: result.totalCards,
    valueCents: result.estimatedValueCents,
    observedValueCents: result.observedValueCents,
    conditionApplied: applyCondition,
    unpricedCards: result.unpricedCards,
    gradedCards: result.gradedCards,
    spareCopies: result.spareCopies,
    spareValueCents: result.spareValueCents,
  };

  const biggest = deck.sets[0]?.cents ?? 0;

  return (
    <>
      <TopBar title="Collection" subtitle={`${summary.totalCards.toLocaleString()} cards`} />
      <main className="px-4 pb-8 pt-4">
        {summary.totalCards === 0 ? (
          <Link href="/app/import" className="panel mb-3 block px-4 py-3.5">
            <p className="text-sm font-semibold">Already track your collection somewhere else?</p>
            <p className="mt-0.5 text-[13px] text-ink-mute">
              Import a CSV and every set you are chasing updates at once.
            </p>
          </Link>
        ) : (
          <>
            {/* ------------------------------------------------ command deck */}
            <section className="panel-raise relative overflow-hidden">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-have/[.09] to-transparent"
              />
              <div className="relative px-5 pb-4 pt-4">
                <p className="label">Collection value</p>
                <p className="figure mt-1.5 text-[2.9rem] text-have">
                  {money(summary.estimatedValueCents)}
                </p>
                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                    <p className="label">Cards</p>
                    <p className="num mt-1 text-[15px] font-bold">
                      {summary.totalCards.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                    <p className="label">Unique</p>
                    <p className="num mt-1 text-[15px] font-bold">
                      {summary.uniqueCards.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                    <p className="label">Sets</p>
                    <p className="num mt-1 text-[15px] font-bold">{summary.setsTouched}</p>
                  </div>
                </div>
                {summary.gainCents !== null && (
                  <p className="mt-3 text-[11px] text-ink-mute">
                    Across the {summary.cardsWithCost} card
                    {summary.cardsWithCost === 1 ? '' : 's'} with a logged purchase price you are{' '}
                    <span
                      className={`num font-bold ${summary.gainCents >= 0 ? 'text-have' : 'text-need'}`}
                    >
                      {summary.gainCents >= 0 ? 'up' : 'down'} {money(Math.abs(summary.gainCents))}
                    </span>
                    .
                  </p>
                )}
              </div>
            </section>

            {/* ------------------------------------------------- top cards */}
            {deck.top.length > 0 && (
              <section className="mt-6">
                <SectionTitle>Most valuable</SectionTitle>
                <ul className="rail rail-bleed flex gap-2.5 overflow-x-auto pb-1">
                  {deck.top.map((c) => (
                    <li key={`${c.card_id}-${c.variant}`} className="shrink-0">
                      <CardTile
                        card={{
                          cardId: c.card_id,
                          name: c.name,
                          number: c.number,
                          variant: c.variant,
                          imageSmall: c.image_small,
                          marketCents: c.cents,
                        }}
                        width="w-[78px]"
                        href={`/app/cards/${c.card_id}`}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ----------------------------------------------- composition */}
            {deck.sets.length > 0 && (
              <section className="mt-6">
                <SectionTitle>Where the value sits</SectionTitle>
                <ul className="space-y-1.5">
                  {deck.sets.map((s) => (
                    <li key={s.set_id}>
                      <Link
                        href={`/app/sets/${s.set_id}`}
                        className="panel flex items-center gap-3 px-3.5 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold">{s.set_name}</p>
                          <Progress
                            value={biggest ? s.cents / biggest : 0}
                            tone="have"
                            height="h-1.5"
                            className="mt-1.5"
                          />
                        </div>
                        <div className="shrink-0 text-right">
                          <Money cents={s.cents} className="block text-[13px] font-bold text-have" />
                          <span className="num text-[10px] text-ink-mute">
                            {s.cards.toLocaleString()} cards
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {/* ------------------------------------------------------- browsing */}
        <section className="mt-7">
          <SectionTitle
            action={
              <Link
                href="/app/import"
                className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
              >
                Import CSV
              </Link>
            }
          >
            {browsing ? 'Browsing' : 'Every card'}
          </SectionTitle>
          <Suspense fallback={<p className="text-sm text-ink-mute">Loading collection…</p>}>
            <CollectionView data={data} />
          </Suspense>
        </section>

        <Disclosure summary="How collection value is worked out" className="mt-6">
          <strong className="text-white">Observed market value</strong> is what a price provider
          quoted for the exact printing you own — {money(summary.observedValueCents)} across this
          collection. The <strong className="text-white">condition-adjusted estimate</strong>{' '}
          multiplies that by a trade-in band (LP 85%, MP 70%, HP 50%, DMG 30%); it is a model
          output, not a quoted price, and you can switch it off above. Cards with no market price
          show &ldquo;—&rdquo; and are excluded rather than counted as zero.
          {summary.gradedCards > 0 && (
            <>
              {' '}
              {summary.gradedCards} graded card{summary.gradedCards === 1 ? ' is' : 's are'} held but
              not valued: a slab and a raw copy are different objects to the market, and SetValue has
              no graded price source to quote.
            </>
          )}
        </Disclosure>
      </main>
    </>
  );
}
