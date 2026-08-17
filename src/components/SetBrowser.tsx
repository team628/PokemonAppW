'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { money } from '@/lib/pricing/quote';

export interface SetCard {
  id: string;
  name: string;
  series: string;
  releaseDate: string | null;
  printedTotal: number;
  total: number;
  logoUrl: string | null;
  symbolUrl: string | null;
  mainSetCents: number;
  mainSetSlots: number;
  ownedCards: number;
  trackedMode: string | null;
}

type Sort = 'newest' | 'oldest' | 'value' | 'progress' | 'name';

export function SetBrowser({ sets }: { sets: SetCard[] }) {
  const [q, setQ] = useState('');
  const [series, setSeries] = useState('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [trackedOnly, setTrackedOnly] = useState(false);

  const allSeries = useMemo(
    () => [...new Set(sets.map((s) => s.series))].sort(),
    [sets],
  );

  const visible = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list = sets.filter((s) => {
      if (trackedOnly && !s.trackedMode) return false;
      if (series !== 'all' && s.series !== series) return false;
      if (!term) return true;
      return s.name.toLowerCase().includes(term) || s.id.toLowerCase().includes(term);
    });
    list = [...list];
    switch (sort) {
      case 'oldest': list.sort((a, b) => (a.releaseDate ?? '').localeCompare(b.releaseDate ?? '')); break;
      case 'value': list.sort((a, b) => b.mainSetCents - a.mainSetCents); break;
      case 'name': list.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'progress':
        list.sort(
          (a, b) =>
            b.ownedCards / Math.max(1, b.total) - a.ownedCards / Math.max(1, a.total),
        );
        break;
      default: list.sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''));
    }
    return list;
  }, [sets, q, series, sort, trackedOnly]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search sets — Base, Evolving Skies, 151…"
        aria-label="Search sets"
        className="field"
        type="search"
      />

      <div className="mt-2 flex items-center gap-1.5 overflow-x-auto pb-1">
        <button
          onClick={() => setTrackedOnly((v) => !v)}
          aria-pressed={trackedOnly}
          className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
            trackedOnly ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Tracking
        </button>
        <select
          value={series}
          onChange={(e) => setSeries(e.target.value)}
          aria-label="Filter by series"
          className="shrink-0 rounded-full border border-ink-line bg-ink px-2.5 py-1.5 text-xs text-ink-mute"
        >
          <option value="all">All series</option>
          {allSeries.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as Sort)}
          aria-label="Sort sets"
          className="shrink-0 rounded-full border border-ink-line bg-ink px-2.5 py-1.5 text-xs text-ink-mute"
        >
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="value">Most valuable</option>
          <option value="progress">Your progress</option>
          <option value="name">A–Z</option>
        </select>
      </div>

      <p className="mt-3 text-[11px] text-ink-mute">
        {visible.length} set{visible.length === 1 ? '' : 's'}. Set value is the sum of every
        non-secret card at one printing each — the cost of a main set at market.
      </p>

      <ul className="mt-3 space-y-2">
        {visible.map((s) => {
          const progress = s.total ? Math.min(1, s.ownedCards / s.total) : 0;
          return (
            <li key={s.id}>
              <Link href={`/app/sets/${s.id}`} className="panel flex items-center gap-3 px-3 py-3">
                {s.symbolUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.symbolUrl} alt="" aria-hidden className="h-7 w-7 shrink-0 object-contain" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded bg-ink" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-semibold">{s.name}</p>
                    {s.trackedMode && (
                      <span className="chip shrink-0 border-have/40 py-0.5 text-[10px] text-have">
                        tracking
                      </span>
                    )}
                  </div>
                  <p className="num text-[11px] text-ink-mute">
                    {s.releaseDate?.replace(/\//g, '.') ?? '—'} · {s.printedTotal} printed
                    {s.total > s.printedTotal && ` (+${s.total - s.printedTotal} secret)`}
                  </p>
                  {s.ownedCards > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full bg-have" style={{ width: `${progress * 100}%` }} />
                      </div>
                      <span className="num text-[10px] text-have">{s.ownedCards}</span>
                    </div>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm font-bold">{money(s.mainSetCents)}</p>
                  <p className="text-[10px] text-ink-mute">main set</p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
