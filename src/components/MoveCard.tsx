import Link from 'next/link';
import { CardArt, Money, SourceNote } from './ui';
import type { Move } from '@/lib/domain/nextBestMove';
import { VARIANT_SHORT, type Variant } from '@/lib/catalog/variants';

const KIND_LABEL: Record<Move['kind'], string> = {
  finish_line: 'Finish line',
  cheap_bundle: 'Best value',
  bulk_fill: 'Bulk fill',
  price_drop: 'Price moved',
  duplicate_leverage: 'Your duplicates',
  trade_match: 'Trade available',
  start_tracking: 'Get started',
};

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
      className={`panel px-4 py-4 ${primary ? 'border-need/40 bg-gradient-to-b from-need/[0.07] to-transparent' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={`chip ${primary ? 'border-need/40 text-need' : ''}`}>
          {KIND_LABEL[move.kind]}
        </span>
        {move.costCents !== null && (
          <Money cents={move.costCents} approx className="text-sm font-bold" />
        )}
      </div>

      <h3 className="mt-2.5 text-[15px] font-bold leading-snug">{move.headline}</h3>
      <p className="mt-1 text-sm leading-relaxed text-ink-mute">{move.detail}</p>

      {move.evidence.length > 0 && (
        <ul className="rail mt-3 flex gap-2 overflow-x-auto pb-1">
          {move.evidence.map((e) => (
            <li key={`${e.cardId}-${e.variant}`} className="w-[64px] shrink-0">
              <CardArt src={e.imageSmall} alt={e.name} />
              <p className="num mt-1 truncate text-[10px] text-ink-mute">
                #{e.number}
                {e.variant !== 'normal' && ` ${VARIANT_SHORT[e.variant as Variant] ?? ''}`}
              </p>
              <p className="num truncate text-[10px] font-semibold">
                {e.note ?? <Money cents={e.cents} />}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Link href={href} className={primary ? 'btn-need flex-1' : 'btn-ghost flex-1'}>
          {move.kind === 'trade_match'
            ? 'See trades'
            : move.kind === 'duplicate_leverage'
              ? 'Review duplicates'
              : move.deltaPoints > 0
                ? `Act on this (+${move.deltaPoints.toFixed(1)} pts)`
                : 'Open'}
        </Link>
      </div>

      <SourceNote className="mt-3 border-t border-ink-line pt-2.5">
        {move.basis}
        {move.confidence === 'estimated' && ' Figures here are estimates, not confirmed sales.'}
      </SourceNote>
    </article>
  );
}
