import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth/session';
import {
  listHoldingsPage,
  portfolioSummary,
  type HoldingsSort,
  type HoldingsView,
} from '@/lib/services/pg/collection';
import { TopBar } from '@/components/AppShell';
import { CollectionView, type CollectionPageData, type HoldingView } from '@/components/CollectionView';
import { SourceNote } from '@/components/ui';
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

  const [summary, result] = await Promise.all([
    portfolioSummary(user.id),
    listHoldingsPage(user.id, {
      view: VIEWS.find((v) => v === sp.view),
      sort: SORTS.find((s) => s === sp.sort),
      q: sp.q,
      page: sp.page ? Number(sp.page) : 1,
      applyCondition,
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

  return (
    <>
      <TopBar
        title="Collection"
        subtitle={`${summary.totalCards.toLocaleString()} cards · ${money(summary.estimatedValueCents)} · ${summary.setsTouched} sets`}
      />
      <main className="px-4 pb-8 pt-4">
        {summary.totalCards === 0 && (
          <Link href="/app/import" className="panel mb-3 block px-4 py-3.5">
            <p className="text-sm font-semibold">Already track your collection somewhere else?</p>
            <p className="mt-0.5 text-[13px] text-ink-mute">
              Import a CSV and every set you are chasing updates at once.
            </p>
          </Link>
        )}

        <Suspense fallback={<p className="text-sm text-ink-mute">Loading collection…</p>}>
          <CollectionView data={data} />
        </Suspense>

        <Link href="/app/import" className="btn-ghost mt-4 w-full">Import from CSV</Link>

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Two different figures, kept apart on purpose. <strong>Observed market value</strong> is
          what a price provider quoted for the exact printing you own —{' '}
          {money(summary.observedValueCents)} across this collection. The{' '}
          <strong>condition-adjusted estimate</strong> multiplies that by a trade-in band
          (LP 85%, MP 70%, HP 50%, DMG 30%); it is a model output, not a quoted price, and you can
          switch it off above. Cards with no market price show &ldquo;—&rdquo; and are excluded
          rather than counted as zero.
          {summary.gradedCards > 0 && (
            <>
              {' '}
              {summary.gradedCards} graded card{summary.gradedCards === 1 ? ' is' : 's are'} held but
              not valued: a slab and a raw copy are different objects to the market, and SetValue has
              no graded price source to quote.
            </>
          )}
          {summary.gainCents !== null && (
            <>
              {' '}Across the {summary.cardsWithCost} card{summary.cardsWithCost === 1 ? '' : 's'} with
              a logged purchase price you are {summary.gainCents >= 0 ? 'up' : 'down'}{' '}
              {money(Math.abs(summary.gainCents))}.
            </>
          )}
        </SourceNote>
      </main>
    </>
  );
}
