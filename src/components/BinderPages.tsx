'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { money } from '@/lib/pricing/quote';
import type { Variant } from '@/lib/catalog/variants';
import { CardArt } from './CardArt';

export interface BinderSlot {
  cardId: string;
  variant: Variant;
  number: string;
  name: string;
  imageSmall: string | null;
  marketCents: number | null;
  owned: boolean;
}

/**
 * Binder view.
 *
 * Collectors do not experience a set as a list — they experience it as pages of
 * a binder, and they know a set is unfinished because a pocket is empty. This
 * lays the set out the way it physically sits, at the pocket count the
 * collector actually uses, so what is on screen matches what is on the table.
 */
export function BinderPages({
  slots,
  setName,
  initialPocket = 9,
}: {
  slots: BinderSlot[];
  setName: string;
  initialPocket?: 4 | 9 | 12;
}) {
  const [pocket, setPocket] = useState<4 | 9 | 12>(initialPocket);
  const [page, setPage] = useState(0);
  const [missingOnly, setMissingOnly] = useState(false);

  const source = useMemo(
    () => (missingOnly ? slots.filter((s) => !s.owned) : slots),
    [slots, missingOnly],
  );

  const pages = useMemo(() => {
    const out: BinderSlot[][] = [];
    for (let i = 0; i < source.length; i += pocket) out.push(source.slice(i, i + pocket));
    return out.length ? out : [[]];
  }, [source, pocket]);

  const safePage = Math.min(page, pages.length - 1);
  const current = pages[safePage] ?? [];
  const cols = pocket === 4 ? 2 : pocket === 12 ? 4 : 3;
  const filled = current.filter((s) => s.owned).length;

  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1">
        {([4, 9, 12] as const).map((p) => (
          <button
            key={p}
            onClick={() => { setPocket(p); setPage(0); }}
            aria-pressed={pocket === p}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
              pocket === p ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
            }`}
          >
            {p}-pocket
          </button>
        ))}
        <button
          onClick={() => { setMissingOnly((v) => !v); setPage(0); }}
          aria-pressed={missingOnly}
          className={`ml-auto shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
            missingOnly ? 'bg-need text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Gaps only
        </button>
      </div>

      <div className="panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold">
            Page {safePage + 1}
            <span className="text-ink-mute"> of {pages.length}</span>
          </p>
          <p className="num text-[11px] text-ink-mute">
            {filled}/{current.length} filled
          </p>
        </div>

        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {current.map((s) => (
            <Link
              key={`${s.cardId}-${s.variant}`}
              href={`/app/cards/${s.cardId}`}
              className="block"
              aria-label={`${s.name} number ${s.number}, ${s.owned ? 'in collection' : 'missing'}`}
            >
              <div className={`relative rounded-lg ${s.owned ? '' : 'ring-1 ring-inset ring-need/30'}`}>
                <CardArt src={s.imageSmall} alt={s.name} owned={s.owned} label={`#${s.number}`} />
                {!s.owned && (
                  <span className="absolute inset-x-0 bottom-1 mx-auto w-fit rounded bg-need px-1.5 py-0.5 text-[9px] font-black text-ink">
                    NEED
                  </span>
                )}
              </div>
              <p className="num mt-1 truncate text-center text-[10px] text-ink-mute">#{s.number}</p>
            </Link>
          ))}
          {Array.from({ length: Math.max(0, pocket - current.length) }).map((_, i) => (
            <div key={`empty-${i}`} className="card-art rounded-lg border border-dashed border-ink-line" />
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          disabled={safePage === 0}
          className="btn-ghost flex-1"
        >
          Previous
        </button>
        <button
          onClick={() => setPage((p) => Math.min(pages.length - 1, p + 1))}
          disabled={safePage >= pages.length - 1}
          className="btn-ghost flex-1"
        >
          Next
        </button>
      </div>

      <p className="mt-3 text-center text-[11px] text-ink-mute">
        {setName} fills {pages.length} {pocket}-pocket page{pages.length === 1 ? '' : 's'}.{' '}
        {missingOnly && `Gaps are worth ${money(source.reduce((t, s) => t + (s.marketCents ?? 0), 0))} at market.`}
      </p>
    </div>
  );
}
