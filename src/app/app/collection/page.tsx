import Link from 'next/link';
import { Suspense } from 'react';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  listHoldingsPage,
  portfolioSummary,
  type HoldingsSort,
  type HoldingsView,
} from '@/lib/services/collection';
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
  searchParams: Promise<{ view?: string; q?: string; sort?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  const summary = portfolioSummary(db, user.id);
  const result = listHoldingsPage(db, user.id, {
    view: VIEWS.find((v) => v === sp.view),
    sort: SORTS.find((s) => s === sp.sort),
    q: sp.q,
    page: sp.page ? Number(sp.page) : 1,
  });

  const rows: HoldingView[] = result.rows.map((h) => ({
    id: h.id,
    cardId: h.card_id,
    variant: h.variant as Variant,
    condition: h.condition,
    quantity: h.quantity,
    paidCents: h.paid_cents,
    valueCents: h.valueCents,
    conditionAdjusted: h.conditionAdjusted,
    forTrade: h.for_trade === 1,
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
    valueCents: result.valueCents,
    unpricedCards: result.unpricedCards,
    gradedCards: result.gradedCards,
    spareCopies: result.spareCopies,
    spareValueCents: result.spareValueCents,
  };

  return (
    <>
      <TopBar
        title="Collection"
        subtitle={`${summary.totalCards.toLocaleString()} cards · ${money(summary.valueCents)} · ${summary.setsTouched} sets`}
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

        <Link href="/app/import" className="btn-ghost mt-4 w-full">
          Import from CSV
        </Link>

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Values are TCGplayer USD market prices for the exact printing you own, discounted for
          condition below Near Mint (LP 85%, MP 70%, HP 50%, DMG 30% — trade-in bands, not quoted
          sales). Cards with no market price show &ldquo;—&rdquo; and are excluded from totals
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
              {' '}Across the {summary.cardsWithCost} card
              {summary.cardsWithCost === 1 ? '' : 's'} with a logged purchase price you are{' '}
              {summary.gainCents >= 0 ? 'up' : 'down'} {money(Math.abs(summary.gainCents))}.
            </>
          )}
        </SourceNote>
      </main>
    </>
  );
}
