'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import { CONDITION_LABEL, type Condition } from '@/lib/domain/conditions';
import { CardArt } from './CardArt';

export interface HoldingView {
  id: string;
  observedMarketCents: number | null;
  conditionMultiplier: number;
  cardId: string;
  variant: Variant;
  condition: Condition;
  quantity: number;
  paidCents: number | null;
  valueCents: number | null;
  conditionAdjusted: boolean;
  forTrade: boolean;
  isGraded: boolean;
  gradeLabel: string | null;
  unvaluedReason: 'graded' | 'unpriced' | null;
  name: string;
  number: string;
  imageSmall: string | null;
  setName: string;
}

export interface CollectionPageData {
  rows: HoldingView[];
  observedValueCents: number;
  conditionApplied: boolean;
  total: number;
  page: number;
  pageCount: number;
  totalCards: number;
  valueCents: number;
  unpricedCards: number;
  gradedCards: number;
  spareCopies: number;
  spareValueCents: number;
}

type View = 'all' | 'duplicates' | 'trade' | 'valuable' | 'graded';
type Sort = 'value' | 'recent' | 'name' | 'set';

const VIEWS: { id: View; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'duplicates', label: 'Duplicates' },
  { id: 'trade', label: 'For trade' },
  { id: 'valuable', label: '$10+' },
  { id: 'graded', label: 'Graded' },
];

/**
 * Collection browser.
 *
 * Filtering, sorting and paging are URL state resolved on the server. Rendering
 * every holding was measured at 17 MB of HTML for a 15,000-card collector, on
 * the phone that collector actually uses; the payload is now flat regardless of
 * collection size, and the totals above the list still describe every card that
 * matched rather than only the page on screen.
 */
export function CollectionView({ data }: { data: CollectionPageData }) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, start] = useTransition();

  const view = (params.get('view') as View) ?? 'all';
  const sort = (params.get('sort') as Sort) ?? 'value';
  const [q, setQ] = useState(params.get('q') ?? '');

  function navigate(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    if (!('page' in patch)) next.delete('page');
    start(() => router.push(`/app/collection?${next.toString()}`, { scroll: false }));
  }

  // Debounced search so typing does not fire a request per keystroke.
  useEffect(() => {
    const current = params.get('q') ?? '';
    if (q === current) return;
    const t = setTimeout(() => navigate({ q: q || null }), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div>
      <div className="panel mb-3 grid grid-cols-2 gap-px overflow-hidden bg-ink-line">
        <div className="bg-ink-soft px-4 py-3">
          <p className="label">{data.conditionApplied ? 'Estimated value' : 'Observed value'}</p>
          <p className="num mt-0.5 text-xl font-bold text-have">{money(data.valueCents)}</p>
          {data.conditionApplied && data.observedValueCents !== data.valueCents && (
            <p className="text-[11px] text-ink-mute">
              observed {money(data.observedValueCents)}
            </p>
          )}
        </div>
        <div className="bg-ink-soft px-4 py-3">
          <p className="label">Cards shown</p>
          <p className="num mt-0.5 text-xl font-bold">{data.totalCards.toLocaleString()}</p>
          {(data.unpricedCards > 0 || data.gradedCards > 0) && (
            <p className="text-[11px] text-ink-mute">
              {[
                data.unpricedCards > 0 && `${data.unpricedCards} unpriced`,
                data.gradedCards > 0 && `${data.gradedCards} graded`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      </div>

      {view === 'duplicates' && (
        <p className="mb-3 rounded-xl border border-gold/30 bg-gold/[0.07] px-3 py-2.5 text-xs leading-relaxed text-gold">
          {data.spareCopies} spare cop{data.spareCopies === 1 ? 'y' : 'ies'} worth about{' '}
          {money(data.spareValueCents)}. Mark them for trade and SetValue matches them against what
          other collectors are missing.
        </p>
      )}

      {view === 'graded' && (
        <p className="mb-3 rounded-xl border border-ink-line bg-ink-soft px-3 py-2.5 text-xs leading-relaxed text-ink-mute">
          Graded cards are held and counted toward set completion, but they are not given a value. A
          slabbed card and a raw one trade at completely different prices, and SetValue has no
          graded price source — so it reports the value as unavailable rather than quoting the raw
          price for a card that is not raw.
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
            onClick={() => navigate({ view: v.id === 'all' ? null : v.id })}
            aria-pressed={view === v.id}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
              view === v.id ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
            }`}
          >
            {v.label}
          </button>
        ))}
        <button
          onClick={() => navigate({ raw: data.conditionApplied ? '1' : null })}
          aria-pressed={!data.conditionApplied}
          title="Show provider-backed figures with no condition model applied"
          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
            !data.conditionApplied ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Observed only
        </button>
        <select
          value={sort}
          onChange={(e) => navigate({ sort: e.target.value })}
          aria-label="Sort collection"
          className="ml-auto shrink-0 rounded-full border border-ink-line bg-ink px-2.5 py-1.5 text-xs text-ink-mute"
        >
          <option value="value">Most valuable</option>
          <option value="recent">Newest sets</option>
          <option value="name">A–Z</option>
          <option value="set">By set</option>
        </select>
      </div>

      <p className="mt-2 text-[11px] text-ink-mute" aria-live="polite">
        {data.total.toLocaleString()} entr{data.total === 1 ? 'y' : 'ies'} match
        {data.pageCount > 1 && ` · page ${data.page} of ${data.pageCount}`}
        {pending && ' · updating…'}
      </p>

      {data.rows.length === 0 ? (
        <div className="panel mt-4 px-4 py-10 text-center">
          <p className="text-sm font-semibold">Nothing here yet</p>
          <p className="mx-auto mt-1 max-w-xs text-xs text-ink-mute">
            {view === 'duplicates'
              ? 'No duplicates. Every card in your collection is a single copy.'
              : view === 'graded'
                ? 'No graded cards logged.'
                : view === 'trade'
                  ? 'Mark spare copies for trade and they show up here — and in other collectors’ match lists.'
                  : 'Add cards from a set page or Card Show mode and they appear here.'}
          </p>
          <Link href="/app/sets" className="btn-ghost mt-4 inline-flex">
            Browse sets
          </Link>
        </div>
      ) : (
        <>
          <ul className="mt-3 space-y-2 lg:grid lg:grid-cols-2 lg:gap-2 lg:space-y-0 xl:grid-cols-3">
            {data.rows.map((h) => (
              <Row key={h.id} h={h} />
            ))}
          </ul>

          {data.pageCount > 1 && (
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => navigate({ page: String(data.page - 1) })}
                disabled={data.page <= 1 || pending}
                className="btn-ghost flex-1"
              >
                Previous
              </button>
              <span className="num shrink-0 text-xs text-ink-mute">
                {data.page} / {data.pageCount}
              </span>
              <button
                onClick={() => navigate({ page: String(data.page + 1) })}
                disabled={data.page >= data.pageCount || pending}
                className="btn-ghost flex-1"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Row({ h }: { h: HoldingView }) {
  const router = useRouter();
  const [forTrade, setForTrade] = useState(h.forTrade);
  const [, start] = useTransition();

  function toggleTrade() {
    const next = !forTrade;
    setForTrade(next);
    start(async () => {
      try {
        const res = await fetch(`/api/collection/item/${h.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ forTrade: next }),
        });
        if (!res.ok) throw new Error();
        router.refresh();
      } catch {
        setForTrade(!next);
      }
    });
  }

  return (
    <li className="panel flex items-center gap-3 p-2.5">
      <Link href={`/app/cards/${h.cardId}`} className="w-[48px] shrink-0">
        <CardArt src={h.imageSmall} alt={h.name} />
      </Link>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{h.name}</p>
        <p className="num truncate text-[11px] text-ink-mute">
          #{h.number} · {h.setName}
        </p>
        <p className="truncate text-[11px] text-ink-mute">
          {VARIANT_LABEL[h.variant]}
          {h.isGraded ? ` · ${h.gradeLabel}` : ` · ${CONDITION_LABEL[h.condition]}`}
          {h.quantity > 1 && ` · ×${h.quantity}`}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {h.isGraded ? (
          <>
            <p className="text-sm font-bold text-ink-mute">—</p>
            <p className="text-[10px] leading-tight text-ink-mute">
              graded
              <br />
              not valued
            </p>
          </>
        ) : (
          <>
            <p className="num text-sm font-bold">
              {h.valueCents === null ? '—' : money(h.valueCents)}
            </p>
            {h.unvaluedReason === 'unpriced' && (
              <p className="text-[10px] text-ink-mute">no market price</p>
            )}
            {h.conditionAdjusted && h.valueCents !== null && (
              <p className="text-[10px] text-ink-mute" title={`Observed ${money(h.observedMarketCents)} × ${h.conditionMultiplier} (${h.condition} band estimate)`}>
                est. {Math.round(h.conditionMultiplier * 100)}% of {money(h.observedMarketCents)}
              </p>
            )}
          </>
        )}
        {h.paidCents !== null && (
          <p className="num text-[10px] text-ink-mute">paid {money(h.paidCents)}</p>
        )}
        {h.quantity > 1 && (
          <button
            onClick={toggleTrade}
            aria-pressed={forTrade}
            className={`mt-1 rounded-full px-2 py-1 text-[10px] font-bold ${
              forTrade ? 'bg-have/20 text-have' : 'border border-ink-line text-ink-mute'
            }`}
          >
            {forTrade ? 'For trade' : 'Trade?'}
          </button>
        )}
      </div>
    </li>
  );
}
