import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listHoldings, portfolioSummary } from '@/lib/services/collection';
import { TopBar } from '@/components/AppShell';
import { CollectionView, type HoldingView } from '@/components/CollectionView';
import { SourceNote } from '@/components/ui';
import { money } from '@/lib/pricing/quote';
import type { Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

export default async function CollectionPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  const summary = portfolioSummary(db, user.id);
  const holdings: HoldingView[] = listHoldings(db, user.id).map((h) => ({
    id: h.id,
    cardId: h.card_id,
    variant: h.variant as Variant,
    condition: h.condition,
    quantity: h.quantity,
    paidCents: h.paid_cents,
    valueCents: h.valueCents,
    unitValueCents: h.unitValueCents,
    conditionAdjusted: h.conditionAdjusted,
    forTrade: h.for_trade === 1,
    name: h.name,
    number: h.number,
    rarity: h.rarity,
    imageSmall: h.image_small,
    setId: h.set_id,
    setName: h.set_name,
    releaseDate: h.release_date,
  }));

  const view = (['all', 'duplicates', 'trade', 'valuable'] as const).find((v) => v === sp.view);

  return (
    <>
      <TopBar
        title="Collection"
        subtitle={`${summary.totalCards.toLocaleString()} cards · ${money(summary.valueCents)} · ${summary.setsTouched} sets`}
      />
      <main className="px-4 pb-8 pt-4">
        <CollectionView holdings={holdings} view={view} />
        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Values are TCGplayer USD market prices for the exact printing you own, discounted for
          condition below Near Mint (LP 85%, MP 70%, HP 50%, DMG 30% — trade-in bands, not quoted
          sales). Cards with no market price are listed at &ldquo;—&rdquo; and excluded from totals
          rather than counted as zero.
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
