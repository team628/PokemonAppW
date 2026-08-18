'use client';

import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
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
 *
 * Three things carry the feeling. A card sits *in* a pocket rather than on the
 * page, so the sheet reads as an object. An empty pocket keeps its full slot
 * and is hatched rather than hidden, because the hole is the information. And
 * the page strip along the bottom shows every page's fill at once, so progress
 * through a 400-card set is legible without turning a single page.
 *
 * Only the open page is rendered, so pocket count and set size cost nothing.
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
  const touch = useRef<{ x: number; y: number } | null>(null);

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
  const gapValue = useMemo(
    () => source.filter((s) => !s.owned).reduce((t, s) => t + (s.marketCents ?? 0), 0),
    [source],
  );

  function turn(delta: number) {
    setPage((p) => Math.max(0, Math.min(pages.length - 1, p + delta)));
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-1.5 overflow-x-auto pb-1">
        {([4, 9, 12] as const).map((p) => (
          <button
            key={p}
            onClick={() => {
              setPocket(p);
              setPage(0);
            }}
            aria-pressed={pocket === p}
            className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
              pocket === p ? 'chip-active' : 'border border-ink-line text-ink-mute'
            }`}
          >
            {p}-pocket
          </button>
        ))}
        <button
          onClick={() => {
            setMissingOnly((v) => !v);
            setPage(0);
          }}
          aria-pressed={missingOnly}
          className={`ml-auto shrink-0 rounded-full px-3 py-1.5 text-[11px] font-semibold transition ${
            missingOnly ? 'bg-need text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Gaps only
        </button>
      </div>

      {/* ------------------------------------------------------- the sheet */}
      <div
        className="panel-raise select-none p-3"
        onTouchStart={(e) => {
          const t = e.touches[0]!;
          touch.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const s = touch.current;
          if (!s) return;
          const t = e.changedTouches[0]!;
          const dx = t.clientX - s.x;
          const dy = t.clientY - s.y;
          // Horizontal intent only, so a vertical scroll never turns a page.
          if (Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.6) turn(dx < 0 ? 1 : -1);
          touch.current = null;
        }}
      >
        <div className="mb-2.5 flex items-baseline justify-between">
          <p className="text-[13px] font-bold">
            Page {safePage + 1}
            <span className="font-medium text-ink-mute"> / {pages.length}</span>
          </p>
          <p className="num text-[11px] text-ink-mute">
            <span className={filled === current.length ? 'font-bold text-have' : ''}>{filled}</span>
            /{current.length} pockets filled
          </p>
        </div>

        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {current.map((s) => (
            <Link
              key={`${s.cardId}-${s.variant}`}
              href={`/app/cards/${s.cardId}`}
              className="group block"
              aria-label={`${s.name} number ${s.number}, ${s.owned ? 'in collection' : 'missing'}`}
            >
              <div className={`pocket relative ${s.owned ? '' : 'pocket-empty'}`}>
                {s.owned ? (
                  <div className="absolute inset-[3px] overflow-hidden rounded-[5px] shadow-slot transition group-active:scale-[.97]">
                    {/* The pocket caption already prints the number; a
                        placeholder that repeated it said the number twice and
                        the card's name not at all. */}
                    <CardArt src={s.imageSmall} alt={s.name} owned />
                  </div>
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                    <span className="num text-[11px] font-bold text-ink-dim">#{s.number}</span>
                    <span className="rounded bg-need/15 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-need">
                      Need
                    </span>
                  </div>
                )}
              </div>
              <p className="num mt-1 truncate text-center text-[10px] text-ink-mute">#{s.number}</p>
            </Link>
          ))}
          {Array.from({ length: Math.max(0, pocket - current.length) }).map((_, i) => (
            <div key={`empty-${i}`} className="pocket opacity-40" aria-hidden />
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => turn(-1)} disabled={safePage === 0} className="btn-ghost px-5" aria-label="Previous page">
          ‹
        </button>
        {/* Every page's fill at a glance — the shape of the whole set. */}
        <ul className="rail flex flex-1 items-end gap-[3px] overflow-x-auto" aria-label="Pages">
          {pages.map((p, i) => {
            const f = p.length ? p.filter((s) => s.owned).length / p.length : 0;
            return (
              <li key={i} className="shrink-0">
                <button
                  onClick={() => setPage(i)}
                  aria-label={`Page ${i + 1}, ${Math.round(f * 100)}% filled`}
                  aria-current={i === safePage ? 'true' : undefined}
                  className={`flex h-7 w-[9px] items-end overflow-hidden rounded-full ${
                    i === safePage ? 'bg-white/25 ring-1 ring-white/60' : 'bg-white/10'
                  }`}
                >
                  <span
                    className={`block w-full rounded-full ${f === 1 ? 'bg-have' : 'bg-need'}`}
                    style={{ height: `${Math.max(f * 100, f > 0 ? 12 : 0)}%` }}
                  />
                </button>
              </li>
            );
          })}
        </ul>
        <button
          onClick={() => turn(1)}
          disabled={safePage >= pages.length - 1}
          className="btn-ghost px-5"
          aria-label="Next page"
        >
          ›
        </button>
      </div>

      <p className="mt-3 text-center text-[11px] text-ink-mute">
        {setName} fills {pages.length} {pocket}-pocket page{pages.length === 1 ? '' : 's'}.
        {gapValue > 0 && <> Gaps are worth {money(gapValue)} at market.</>}
      </p>
    </div>
  );
}
