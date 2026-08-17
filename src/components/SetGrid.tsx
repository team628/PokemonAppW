'use client';

import Link from 'next/link';
import { useMemo, useOptimistic, useState, useTransition } from 'react';
import { money } from '@/lib/pricing/quote';
import { VARIANT_SHORT, type Variant } from '@/lib/catalog/variants';
import type { GoalMode } from '@/lib/domain/goals';
import { CardArt } from './CardArt';

export interface GridSlot {
  cardId: string;
  variant: Variant;
  number: string;
  numberSort: number;
  name: string;
  rarity: string | null;
  imageSmall: string | null;
  isSecret: boolean;
  marketCents: number | null;
  acquisitionCents: number | null;
  basis: string | null;
  observedOn: string | null;
  variantSource: 'market_data' | 'inferred';
  owned: boolean;
  quantity: number;
}

type Filter = 'all' | 'missing' | 'owned';
type Sort = 'number' | 'value' | 'cheapest';

/**
 * The set page.
 *
 * One tap toggles ownership. The tap has to feel instantaneous — someone
 * standing at a shop table logging a stack of cards will notice 300ms — so the
 * grid updates optimistically and reconciles with the server response, which
 * returns freshly computed totals rather than trusting the client's arithmetic.
 */
export function SetGrid({
  setId,
  mode,
  slots: initial,
  initialFilter = 'all',
}: {
  setId: string;
  mode: GoalMode;
  slots: GridSlot[];
  initialFilter?: Filter;
}) {
  const [slots, setSlots] = useState(initial);
  const [optimistic, applyOptimistic] = useOptimistic(
    slots,
    (state: GridSlot[], patch: { cardId: string; variant: string; owned: boolean }) =>
      state.map((s) =>
        s.cardId === patch.cardId && s.variant === patch.variant
          ? { ...s, owned: patch.owned, quantity: patch.owned ? Math.max(1, s.quantity) : 0 }
          : s,
      ),
  );
  const [filter, setFilter] = useState<Filter>(initialFilter);
  const [sort, setSort] = useState<Sort>('number');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const list = optimistic.filter((s) =>
      filter === 'all' ? true : filter === 'missing' ? !s.owned : s.owned,
    );
    const sorted = [...list];
    if (sort === 'value') sorted.sort((a, b) => (b.marketCents ?? -1) - (a.marketCents ?? -1));
    else if (sort === 'cheapest')
      sorted.sort(
        (a, b) => (a.acquisitionCents ?? Number.MAX_SAFE_INTEGER) - (b.acquisitionCents ?? Number.MAX_SAFE_INTEGER),
      );
    else sorted.sort((a, b) => a.numberSort - b.numberSort || a.variant.localeCompare(b.variant));
    return sorted;
  }, [optimistic, filter, sort]);

  const live = useMemo(() => {
    const owned = optimistic.filter((s) => s.owned);
    const missing = optimistic.filter((s) => !s.owned);
    const sum = (xs: GridSlot[]) => xs.reduce((t, s) => t + (s.marketCents ?? 0), 0);
    return {
      ownedCount: owned.length,
      missingCount: missing.length,
      required: optimistic.length,
      need: sum(missing),
      have: sum(owned),
      percent: optimistic.length ? owned.length / optimistic.length : 0,
      unpricedMissing: missing.filter((s) => s.marketCents === null).length,
    };
  }, [optimistic]);

  function toggle(slot: GridSlot) {
    const next = !slot.owned;
    setError(null);
    startTransition(async () => {
      applyOptimistic({ cardId: slot.cardId, variant: slot.variant, owned: next });
      try {
        const res = await fetch(next ? '/api/collection/add' : '/api/collection/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardId: slot.cardId,
            variant: slot.variant,
            quantity: 1,
            withMode: mode,
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Request failed');
        setSlots((prev) =>
          prev.map((s) =>
            s.cardId === slot.cardId && s.variant === slot.variant
              ? { ...s, owned: next, quantity: next ? Math.max(1, s.quantity) : 0 }
              : s,
          ),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not save that change.');
      }
    });
  }

  return (
    <div>
      <div className="sticky top-[57px] z-20 -mx-4 border-b border-ink-line bg-ink/95 px-4 py-3 backdrop-blur">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="num text-2xl font-black leading-none text-need">{money(live.need)}</p>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-need/80">
              {live.unpricedMissing > 0 ? 'To go (at least)' : 'To go'}
            </p>
          </div>
          <div className="text-right">
            <p className="num text-sm font-bold">{(live.percent * 100).toFixed(1)}%</p>
            <p className="num text-[11px] text-ink-mute">
              {live.ownedCount}/{live.required} · {live.missingCount} left
            </p>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-need transition-[width] duration-300"
            style={{ width: `${live.percent * 100}%` }}
          />
        </div>

        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto">
          {(['all', 'missing', 'owned'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold capitalize transition ${
                filter === f ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
              }`}
            >
              {f === 'all' ? `All ${live.required}` : f === 'missing' ? `Missing ${live.missingCount}` : `Have ${live.ownedCount}`}
            </button>
          ))}
          <span className="ml-auto shrink-0" />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort cards"
            className="shrink-0 rounded-full border border-ink-line bg-ink px-2.5 py-1.5 text-xs text-ink-mute"
          >
            <option value="number">By number</option>
            <option value="value">Most valuable</option>
            <option value="cheapest">Cheapest to get</option>
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-need/40 bg-need/10 px-3 py-2 text-xs text-need">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="panel mt-4 px-4 py-8 text-center text-sm text-ink-mute">
          {filter === 'missing'
            ? 'Nothing missing here. This goal is finished.'
            : 'No cards match this filter yet.'}
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
          {visible.map((s) => (
            <li key={`${s.cardId}-${s.variant}`}>
              <button
                onClick={() => toggle(s)}
                disabled={pending}
                aria-pressed={s.owned}
                aria-label={`${s.owned ? 'Remove' : 'Add'} ${s.name} number ${s.number}${
                  s.variant !== 'normal' ? ` ${VARIANT_SHORT[s.variant]}` : ''
                }`}
                className={`group relative block w-full rounded-lg transition active:scale-95 ${
                  s.owned ? '' : 'opacity-95'
                }`}
              >
                <CardArt src={s.imageSmall} alt={s.name} owned={s.owned} label={`#${s.number}`} />
                {s.owned && (
                  <span
                    aria-hidden
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-have text-[11px] font-black text-ink shadow"
                  >
                    ✓
                  </span>
                )}
                {s.quantity > 1 && (
                  <span className="num absolute left-1 top-1 rounded-md bg-ink/85 px-1.5 py-0.5 text-[10px] font-bold">
                    ×{s.quantity}
                  </span>
                )}
                {mode === 'master' && s.variant !== 'normal' && (
                  <span className="num absolute bottom-1 left-1 rounded bg-ink/85 px-1 py-0.5 text-[9px] font-bold text-gold">
                    {VARIANT_SHORT[s.variant]}
                  </span>
                )}
              </button>
              <div className="mt-1 flex items-baseline justify-between gap-1 px-0.5">
                <Link
                  href={`/app/cards/${s.cardId}`}
                  className="num truncate text-[10px] text-ink-mute hover:text-white"
                >
                  #{s.number}
                </Link>
                <span
                  className={`num text-[10px] font-semibold ${s.owned ? 'text-have' : 'text-need'}`}
                  title={
                    s.basis
                      ? `${s.basis} price, observed ${s.observedOn}`
                      : 'No market price available for this printing'
                  }
                >
                  {s.marketCents === null ? '—' : money(s.marketCents)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
