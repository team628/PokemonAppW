import Link from 'next/link';
import { Disclosure, Money } from './ui';
import { CardTile } from './CardTile';
import type { Move } from '@/lib/domain/nextBestMove';

const KIND_LABEL: Record<Move['kind'], string> = {
  finish_line: 'Finish line',
  cheap_bundle: 'Best value',
  bulk_fill: 'Bulk fill',
  price_drop: 'Price moved',
  duplicate_leverage: 'Your duplicates',
  trade_match: 'Trade available',
  start_tracking: 'Get started',
};

const CTA: Partial<Record<Move['kind'], string>> = {
  trade_match: 'See trades',
  duplicate_leverage: 'Review duplicates',
  start_tracking: 'Browse sets',
};

/**
 * A recommendation, as a collector reads it.
 *
 * The cards come first, because "which cards" is the question. Then the money
 * and the completion it buys. The reasoning is still fully available, but it
 * sits behind a disclosure instead of being the tallest thing on the card —
 * three of these used to fill a phone screen with prose.
 */
export function MoveCard({ move, primary = false }: { move: Move; primary?: boolean }) {
  const href =
    move.setId && move.goalId
      ? `/app/sets/${move.setId}?mode=${move.mode}&filter=missing`
      : move.kind === 'trade_match'
        ? '/app/trade'
        : move.kind === 'duplicate_leverage'
          ? '/app/collection?view=duplicates'
          : '/app/sets';

  return (
    <article
      className={`panel overflow-hidden ${
        primary ? 'border-need/35 bg-gradient-to-b from-need/[.06] to-transparent' : ''
      }`}
    >
      <div className="px-4 pt-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className={`chip ${primary ? 'border-need/40 text-need' : ''}`}>
              {KIND_LABEL[move.kind]}
            </span>
            <h3 className="mt-2 text-[15px] font-bold leading-snug">{move.headline}</h3>
          </div>
          {move.costCents !== null && (
            <div className="shrink-0 text-right">
              <Money cents={move.costCents} approx className="block text-[17px] font-bold" />
              {move.deltaPoints > 0 && (
                <span className="num mt-0.5 block text-[11px] font-bold text-have">
                  +{move.deltaPoints.toFixed(1)} pts
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {move.evidence.length > 0 && (
        <ul className="rail mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
          {move.evidence.map((e) => (
            <li key={`${e.cardId}-${e.variant}`} className="shrink-0">
              <CardTile
                card={{
                  cardId: e.cardId,
                  name: e.name,
                  number: e.number,
                  variant: e.variant,
                  imageSmall: e.imageSmall,
                  marketCents: e.cents,
                  owned: false,
                }}
                width="w-[62px]"
                href={`/app/cards/${e.cardId}`}
                showPrice={!e.note}
              />
              {e.note && (
                <p className="num mt-0.5 w-[62px] truncate text-[10px] font-semibold text-have">
                  {e.note}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="px-4 pb-3.5 pt-3">
        <Link href={href} className={primary ? 'btn-need w-full' : 'btn-ghost w-full'}>
          {CTA[move.kind] ?? 'Open'}
        </Link>
        <Disclosure summary="Why this move" className="mt-3">
          {move.detail} {move.basis}
          {move.confidence === 'estimated' && ' These are estimates, not confirmed sales.'}
        </Disclosure>
      </div>
    </article>
  );
}
