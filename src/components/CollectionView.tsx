'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import { CONDITION_LABEL, type Condition } from '@/lib/domain/conditions';
import { CardArt } from './ui';

export interface HoldingView {
  id: string;
  cardId: string;
  variant: Variant;
  condition: Condition;
  quantity: number;
  paidCents: number | null;
  valueCents: number | null;
  unitValueCents: number | null;
  conditionAdjusted: boolean;
  forTrade: boolean;
  name: string;
  number: string;
  rarity: string | null;
  imageSmall: string | null;
  setId: string;
  setName: string;
  releaseDate: string | null;
}

type View = 'all' | 'duplicates' | 'trade' | 'valuable';
type Sort = 'value' | 'recent' | 'name' | 'set';

export function CollectionView({
  holdings: initial,
  view: initialView = 'all',
}: {
  holdings: HoldingView[];
  view?: View;
}) {
  const [holdings, setHoldings] = useState(initial);
  const [view, setView] = useState<View>(initialView);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('value');
  const [, start] = useTransition();

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list = holdings.filter((h) => {
      if (view === 'duplicates' && h.quantity < 2) return false;
      if (view === 'trade' && !h.forTrade) return false;
      if (view === 'valuable' && (h.unitValueCents ?? 0) < 1000) return false;
      if (!term) return true;
      return (
        h.name.toLowerCase().includes(term) ||
        h.setName.toLowerCase().includes(term) ||
        h.number === term
      );
    });
    list = [...list];
    switch (sort) {
      case 'name': list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'set':
        list.sort((a, b) => a.setName.localeCompare(b.setName) || a.number.localeCompare(b.number));
        break;
      case 'recent': break; // server already returns newest sets first
      default: list.sort((a, b) => (b.valueCents ?? -1) - (a.valueCents ?? -1));
    }
    return list;
  }, [holdings, view, q, sort]);

  const totals = useMemo(() => {
    let value = 0, cards = 0, unpriced = 0, spares = 0, spareValue = 0;
    for (const h of visible) {
      cards += h.quantity;
      if (h.valueCents === null) unpriced += h.quantity;
      else value += h.valueCents;
      if (h.quantity > 1) {
        spares += h.quantity - 1;
        spareValue += (h.unitValueCents ?? 0) * (h.quantity - 1);
      }
    }
    return { value, cards, unpriced, spares, spareValue };
  }, [visible]);

  function toggleTrade(h: HoldingView) {
    const next = !h.forTrade;
    setHoldings((prev) => prev.map((x) => (x.id === h.id ? { ...x, forTrade: next } : x)));
    start(async () => {
      await fetch(`/api/collection/item/${h.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forTrade: next }),
      }).catch(() => {
        setHoldings((prev) => prev.map((x) => (x.id === h.id ? { ...x, forTrade: !next } : x)));
      });
    });
  }

  const VIEWS: { id: View; label: string }[] = [
    { id: 'all', label: 'Everything' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'trade', label: 'For trade' },
    { id: 'valuable', label: '$10+' },
  ];

  return (
    <div>
      <div className="panel mb-3 grid grid-cols-2 gap-px overflow-hidden bg-ink-line">
        <div className="bg-ink-soft px-4 py-3">
          <p className="label">Value shown</p>
          <p className="num mt-0.5 text-xl font-bold text-have">{money(totals.value)}</p>
        </div>
        <div className="bg-ink-soft px-4 py-3">
          <p className="label">Cards shown</p>
          <p className="num mt-0.5 text-xl font-bold">{totals.cards.toLocaleString()}</p>
          {totals.unpriced > 0 && (
            <p className="text-[11px] text-ink-mute">{totals.unpriced} unpriced</p>
          )}
        </div>
      </div>

      {view === 'duplicates' && (
        <p className="mb-3 rounded-xl border border-gold/30 bg-gold/[0.07] px-3 py-2.5 text-xs leading-relaxed text-gold">
          {totals.spares} spare cop{totals.spares === 1 ? 'y' : 'ies'} worth about{' '}
          {money(totals.spareValue)}. Mark them for trade and SetValue matches them against what
          other collectors are missing.
        </p>
      )}

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your collection…"
        aria-label="Search collection"
        type="search"
        className="field"
      />

      <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-1">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            aria-pressed={view === v.id}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
              view === v.id ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
            }`}
          >
            {v.label}
          </button>
        ))}
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort collection"
          className="ml-auto shrink-0 rounded-full border border-ink-line bg-ink px-2.5 py-1.5 text-xs text-ink-mute"
        >
          <option value="value">Most valuable</option>
          <option value="recent">Newest sets</option>
          <option value="name">A–Z</option>
          <option value="set">By set</option>
        </select>
      </div>

      {visible.length === 0 ? (
        <div className="panel mt-4 px-4 py-10 text-center">
          <p className="text-sm font-semibold">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-ink-mute">
            {view === 'duplicates'
              ? 'No duplicates. Every card in your collection is a single copy.'
              : view === 'trade'
                ? 'Mark spare copies for trade and they show up here — and in other collectors’ match lists.'
                : 'Add cards from a set page or Card Show mode and they appear here.'}
          </p>
          <Link href="/app/sets" className="btn-ghost mt-4 inline-flex">
            Browse sets
          </Link>
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {visible.map((h) => (
            <li key={h.id} className="panel flex items-center gap-3 p-2.5">
              <Link href={`/app/cards/${h.cardId}`} className="w-[48px] shrink-0">
                <CardArt src={h.imageSmall} alt={h.name} />
              </Link>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{h.name}</p>
                <p className="num truncate text-[11px] text-ink-mute">
                  #{h.number} · {h.setName}
                </p>
                <p className="truncate text-[11px] text-ink-mute">
                  {VARIANT_LABEL[h.variant]} · {CONDITION_LABEL[h.condition]}
                  {h.quantity > 1 && ` · ×${h.quantity}`}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="num text-sm font-bold">
                  {h.valueCents === null ? '—' : money(h.valueCents)}
                </p>
                {h.conditionAdjusted && h.valueCents !== null && (
                  <p className="text-[10px] text-ink-mute">condition adj.</p>
                )}
                {h.paidCents !== null && (
                  <p className="num text-[10px] text-ink-mute">paid {money(h.paidCents)}</p>
                )}
                {h.quantity > 1 && (
                  <button
                    onClick={() => toggleTrade(h)}
                    aria-pressed={h.forTrade}
                    className={`mt-1 rounded-full px-2 py-1 text-[10px] font-bold ${
                      h.forTrade ? 'bg-have/20 text-have' : 'border border-ink-line text-ink-mute'
                    }`}
                  >
                    {h.forTrade ? 'For trade' : 'Trade?'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
