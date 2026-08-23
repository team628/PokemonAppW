'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * On a wide screen the binder opens: two facing pages, the way it sits on a
 * table, and a page turn moves the spread rather than a single sheet. That is
 * the one place this view should not simply be the phone layout made larger —
 * a real binder is two pages, and a desktop has room for both.
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
  const [spread, setSpread] = useState(false);

  // Two facing pages once there is room for them. Read from the same breakpoint
  // the layout uses, so the two can never disagree.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setSpread(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const source = useMemo(
    () => (missingOnly ? slots.filter((s) => !s.owned) : slots),
    [slots, missingOnly],
  );

  const pages = useMemo(() => {
    const out: BinderSlot[][] = [];
    for (let i = 0; i < source.length; i += pocket) out.push(source.slice(i, i + pocket));
    return out.length ? out : [[]];
  }, [source, pocket]);

  const step = spread ? 2 : 1;
  const safePage = Math.min(page, pages.length - 1);
  // The left-hand sheet of a spread is always the even page, so turning back
  // and forth does not shuffle which cards face each other.
  const firstPage = spread ? safePage - (safePage % 2) : safePage;
  const openPages = spread
    ? [firstPage, firstPage + 1].filter((i) => i < pages.length)
    : [safePage];
  const cols = pocket === 4 ? 2 : pocket === 12 ? 4 : 3;
  const gapValue = useMemo(
    () => source.filter((s) => !s.owned).reduce((t, s) => t + (s.marketCents ?? 0), 0),
    [source],
  );

  function turn(delta: number) {
    setPage((p) => Math.max(0, Math.min(pages.length - 1, p + delta * step)));
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
        className="panel-raise select-none p-3 lg:p-5"
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
        <div className="lg:flex lg:gap-6">
          {openPages.map((index, seat) => {
            const sheet = pages[index] ?? [];
            const sheetFilled = sheet.filter((s) => s.owned).length;
            return (
              <div
                key={index}
                className={`min-w-0 flex-1 ${seat > 0 ? 'lg:border-l lg:border-ink-line lg:pl-6' : ''}`}
              >
                <div className="mb-2.5 flex items-baseline justify-between">
                  <p className="text-[13px] font-bold">
                    Page {index + 1}
                    <span className="font-medium text-ink-mute"> / {pages.length}</span>
                  </p>
                  <p className="num text-[11px] text-ink-mute">
                    <span className={sheetFilled === sheet.length ? 'font-bold text-have' : ''}>
                      {sheetFilled}
                    </span>
                    /{sheet.length} pockets filled
                  </p>
                </div>

                <div
                  className="grid gap-2 lg:gap-3"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {sheet.map((s) => (
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
                                placeholder that repeated it said the number
                                twice and the card's name not at all. */}
                            <CardArt src={s.imageSmall} alt={s.name} owned />
                          </div>
                        ) : (
                          // The caption under the pocket already prints the
                          // number, so printing it in here too said the number
                          // twice and never said which card is missing.
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1.5 text-center">
                            <span className="line-clamp-2 text-[10px] font-semibold leading-tight text-ink-dim">
                              {s.name}
                            </span>
                            <span className="rounded bg-need/15 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-need">
                              Need
                            </span>
                          </div>
                        )}
                      </div>
                      <p className="num mt-1 truncate text-center text-[10px] text-ink-mute lg:text-[11px]">
                        #{s.number}
                      </p>
                    </Link>
                  ))}
                  {Array.from({ length: Math.max(0, pocket - sheet.length) }).map((_, i) => (
                    <div key={`empty-${i}`} className="pocket opacity-40" aria-hidden />
                  ))}
                </div>
              </div>
            );
          })}
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
                  aria-current={openPages.includes(i) ? 'true' : undefined}
                  className={`flex h-7 w-[9px] items-end overflow-hidden rounded-full ${
                    openPages.includes(i) ? 'bg-white/25 ring-1 ring-white/60' : 'bg-white/10'
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
          disabled={(openPages[openPages.length - 1] ?? safePage) >= pages.length - 1}
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
