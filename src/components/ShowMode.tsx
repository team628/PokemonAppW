'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import type { GoalMode } from '@/lib/domain/goals';
import { CardArt } from './CardArt';

export interface PullSlot {
  cardId: string;
  variant: Variant;
  number: string;
  name: string;
  rarity: string | null;
  imageSmall: string | null;
  marketCents: number | null;
  acquisitionCents: number | null;
}

export interface ShowSetOption {
  id: string;
  name: string;
  mode: GoalMode;
  missingCount: number;
  needCents: number;
  percent: number;
}

interface QueuedFind {
  key: string;
  sessionId: string;
  cardId: string;
  variant: Variant;
  paidCents: number | null;
  withMode: GoalMode;
}

const QUEUE_KEY = 'setvalue.show.queue.v1';

/**
 * Card Show mode.
 *
 * Built for the actual situation: standing at a table, phone in one hand, a
 * stack of cards in the other, patchy hall wifi, and a seller waiting. So:
 * every control sits in the lower half of the screen, targets are large, the
 * pull list is the default view (you are digging, not searching), and a find
 * that cannot reach the server is queued locally and replayed rather than lost.
 */
export function ShowMode({
  sessionId,
  sets,
  initialSetId,
  pullList,
  initialSummary,
}: {
  sessionId: string;
  sets: ShowSetOption[];
  initialSetId: string | null;
  pullList: PullSlot[];
  initialSummary: { finds: number; spentCents: number; marketCents: number };
}) {
  const [setId, setSetId] = useState(initialSetId);
  const [slots, setSlots] = useState(pullList);
  const [summary, setSummary] = useState(initialSummary);
  const [needCents, setNeedCents] = useState(
    sets.find((s) => s.id === initialSetId)?.needCents ?? 0,
  );
  const [missingCount, setMissingCount] = useState(
    sets.find((s) => s.id === initialSetId)?.missingCount ?? 0,
  );
  const [tab, setTab] = useState<'pull' | 'lookup'>('pull');
  const [queue, setQueue] = useState<QueuedFind[]>([]);
  const [online, setOnline] = useState(true);
  const [flash, setFlash] = useState<{ name: string; saved: number | null } | null>(null);
  const [priceFor, setPriceFor] = useState<PullSlot | null>(null);
  const activeSet = sets.find((s) => s.id === setId);
  const mode: GoalMode = activeSet?.mode ?? 'main';

  // ---- offline queue ------------------------------------------------------
  useEffect(() => {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      if (raw) setQueue(JSON.parse(raw));
    } catch {
      /* storage unavailable — mode still works, just without replay */
    }
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    setOnline(navigator.onLine);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  const persist = useCallback((q: QueuedFind[]) => {
    setQueue(q);
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback(
    async (item: QueuedFind): Promise<boolean> => {
      try {
        const res = await fetch('/api/show/find', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: item.sessionId,
            cardId: item.cardId,
            variant: item.variant,
            paidCents: item.paidCents,
            withMode: item.withMode,
            idempotencyKey: item.key,
          }),
        });
        if (!res.ok) return false;
        const data = await res.json();
        if (data.summary) setSummary(data.summary);
        if (data.metrics && data.metrics.setId === setId) {
          setNeedCents(data.metrics.needCents);
          setMissingCount(data.metrics.missingCount);
        }
        return true;
      } catch {
        return false;
      }
    },
    [setId],
  );

  const flushRef = useRef(false);
  const flush = useCallback(async () => {
    if (flushRef.current || !queue.length) return;
    flushRef.current = true;
    const remaining: QueuedFind[] = [];
    for (const item of queue) if (!(await send(item))) remaining.push(item);
    persist(remaining);
    flushRef.current = false;
  }, [queue, send, persist]);

  useEffect(() => {
    if (online && queue.length) void flush();
  }, [online, queue.length, flush]);

  // ---- the FOUND IT action ------------------------------------------------
  async function found(slot: PullSlot, paidCents: number | null) {
    const item: QueuedFind = {
      key: `${slot.cardId}-${slot.variant}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId,
      cardId: slot.cardId,
      variant: slot.variant,
      paidCents,
      withMode: mode,
    };

    // Local truth updates first: the card is in your hand, the screen should
    // agree immediately whether or not the network does.
    setSlots((prev) => prev.filter((s) => !(s.cardId === slot.cardId && s.variant === slot.variant)));
    setMissingCount((n) => Math.max(0, n - 1));
    setNeedCents((c) => Math.max(0, c - (slot.marketCents ?? 0)));
    setSummary((s) => ({
      finds: s.finds + 1,
      spentCents: s.spentCents + (paidCents ?? 0),
      marketCents: s.marketCents + (slot.marketCents ?? 0),
    }));
    setFlash({
      name: slot.name,
      saved: paidCents !== null && slot.marketCents !== null ? slot.marketCents - paidCents : null,
    });
    setTimeout(() => setFlash(null), 2200);
    setPriceFor(null);

    if (!(await send(item))) persist([...queue, item]);
  }

  const listValue = useMemo(
    () => slots.reduce((t, s) => t + (s.acquisitionCents ?? 0), 0),
    [slots],
  );

  return (
    <div className="pb-4">
      {/* running tally — the number that makes the session feel like progress */}
      <div className="panel sticky top-[57px] z-20 mb-4 px-4 py-3">
        <div className="flex items-end justify-between">
          <div>
            <p className="label">Still need{activeSet ? ` · ${activeSet.name}` : ''}</p>
            <p className="num text-3xl font-black leading-none text-need">{money(needCents)}</p>
            <p className="num mt-1 text-[11px] text-ink-mute">{missingCount} cards left</p>
          </div>
          <div className="text-right">
            <p className="label">This hunt</p>
            <p className="num text-lg font-bold">{summary.finds} found</p>
            <p className="num text-[11px] text-ink-mute">
              {money(summary.spentCents)} spent · {money(summary.marketCents)} market
            </p>
          </div>
        </div>
        {(!online || queue.length > 0) && (
          <p className="mt-2 rounded-lg bg-gold/10 px-2.5 py-1.5 text-[11px] font-semibold text-gold">
            {online
              ? `Syncing ${queue.length} find${queue.length === 1 ? '' : 's'}…`
              : `Offline — ${queue.length} find${queue.length === 1 ? '' : 's'} saved on this device and will sync automatically.`}
          </p>
        )}
      </div>

      {sets.length > 1 && (
        <div className="rail mb-3 flex gap-2 overflow-x-auto">
          {sets.map((s) => (
            <button
              key={`${s.id}-${s.mode}`}
              onClick={() => {
                setSetId(s.id);
                setNeedCents(s.needCents);
                setMissingCount(s.missingCount);
                window.location.href = `/app/show?set=${s.id}&mode=${s.mode}`;
              }}
              className={`shrink-0 rounded-full px-3 py-2 text-xs font-semibold ${
                s.id === setId ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
              }`}
            >
              {s.name} · {s.missingCount}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 flex gap-1.5">
        <button
          onClick={() => setTab('pull')}
          aria-pressed={tab === 'pull'}
          className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold ${
            tab === 'pull' ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Pull list ({slots.length})
        </button>
        <button
          onClick={() => setTab('lookup')}
          aria-pressed={tab === 'lookup'}
          className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold ${
            tab === 'lookup' ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
          }`}
        >
          Look up a card
        </button>
      </div>

      {tab === 'lookup' ? (
        <Lookup setId={setId} onFound={found} />
      ) : slots.length === 0 ? (
        <div className="panel px-4 py-10 text-center">
          <p className="text-sm font-semibold">
            {activeSet ? 'Nothing left to find here.' : 'Pick a set to build a pull list.'}
          </p>
          <p className="mt-1 text-xs text-ink-mute">
            {activeSet
              ? 'Every card in this goal is in your collection.'
              : 'Track a set and its missing cards appear here, sorted for digging.'}
          </p>
          <Link href="/app/sets" className="btn-ghost mt-4 inline-flex">
            Browse sets
          </Link>
        </div>
      ) : (
        <>
          <p className="mb-2 text-[11px] text-ink-mute">
            Sorted by card number so it tracks the order cards sit in a binder or box.{' '}
            {money(listValue)} buys this whole list at the lowest current listings.
          </p>
          <ul className="space-y-2">
            {slots.map((s) => (
              <li key={`${s.cardId}-${s.variant}`} className="panel flex items-center gap-3 p-2.5">
                <div className="w-[52px] shrink-0">
                  <CardArt src={s.imageSmall} alt={s.name} label={`#${s.number}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{s.name}</p>
                  <p className="num text-[11px] text-ink-mute">
                    #{s.number}
                    {s.variant !== 'normal' && ` · ${VARIANT_LABEL[s.variant]}`}
                    {s.rarity && ` · ${s.rarity}`}
                  </p>
                  <p className="num mt-0.5 text-xs font-semibold text-need">
                    {s.marketCents === null ? 'no market price' : `${money(s.marketCents)} market`}
                    {s.acquisitionCents !== null && s.acquisitionCents !== s.marketCents && (
                      <span className="text-ink-mute"> · from {money(s.acquisitionCents)}</span>
                    )}
                  </p>
                </div>
                <button
                  onClick={() => setPriceFor(s)}
                  className="btn-need min-h-[52px] shrink-0 px-4 text-xs"
                  aria-label={`Mark ${s.name} number ${s.number} as found`}
                >
                  FOUND IT
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {priceFor && (
        <PriceSheet slot={priceFor} onCancel={() => setPriceFor(null)} onConfirm={found} />
      )}

      {flash && (
        <div
          role="status"
          className="animate-slideUp fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-have/40 bg-have/15 px-4 py-3 backdrop-blur"
        >
          <p className="text-sm font-bold text-have">Added — {flash.name}</p>
          {flash.saved !== null && (
            <p className="num text-xs text-have/80">
              {flash.saved >= 0
                ? `${money(flash.saved)} under market`
                : `${money(-flash.saved)} over market`}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Asks what was paid. Skippable in one tap — nobody wants a form mid-transaction. */
function PriceSheet({
  slot,
  onCancel,
  onConfirm,
}: {
  slot: PullSlot;
  onCancel: () => void;
  onConfirm: (slot: PullSlot, paidCents: number | null) => void;
}) {
  const [value, setValue] = useState('');
  const cents = value.trim() === '' ? null : Math.round(parseFloat(value) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-ink/70 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="animate-slideUp w-full rounded-t-3xl border-t border-ink-line bg-ink-soft p-5"
        style={{ paddingBottom: 'calc(1.25rem + var(--safe-b))' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-14 shrink-0">
            <CardArt src={slot.imageSmall} alt={slot.name} label={`#${slot.number}`} />
          </div>
          <div className="min-w-0">
            <p className="truncate font-bold">{slot.name}</p>
            <p className="num text-xs text-ink-mute">
              #{slot.number} · market {slot.marketCents === null ? '—' : money(slot.marketCents)}
            </p>
          </div>
        </div>

        <label className="label mt-5 block" htmlFor="paid">
          What did you pay? (optional)
        </label>
        <input
          id="paid"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0.00"
          className="field mt-1.5 text-2xl font-bold"
        />

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button onClick={() => onConfirm(slot, null)} className="btn-ghost">
            Skip price
          </button>
          <button
            onClick={() => onConfirm(slot, Number.isFinite(cents as number) ? cents : null)}
            className="btn-need"
          >
            Add to collection
          </button>
        </div>
        <p className="mt-3 text-[11px] text-ink-mute">
          Logging what you paid is what lets SetValue show the difference between what a hunt cost
          and what it was worth.
        </p>
      </div>
    </div>
  );
}

interface SearchHit {
  id: string;
  name: string;
  number: string;
  set_id: string;
  set_name: string;
  rarity: string | null;
  image_small: string | null;
  market_cents: number | null;
}

function Lookup({
  setId,
  onFound,
}: {
  setId: string | null;
  onFound: (slot: PullSlot, paidCents: number | null) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `/api/search?q=${encodeURIComponent(term)}${setId ? `&set=${setId}` : ''}`;
        const res = await fetch(url);
        const data = await res.json();
        setHits(data.results ?? []);
      } catch {
        setHits([]);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => clearTimeout(t);
  }, [q, setId]);

  return (
    <div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={setId ? 'Card number or name…' : 'Card name…'}
        inputMode={setId ? 'numeric' : 'text'}
        aria-label="Search cards"
        autoFocus
        className="field text-lg"
      />
      <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
        {setId
          ? 'Type the number printed on the card — 4, 25, 151 — for an exact hit.'
          : 'Searching every English set. Choose a set above to search by card number instead.'}{' '}
        <span className="text-ink-mute/80">
          Photo recognition is not available in this build, so SetValue does not offer a
          scan button it cannot stand behind. Set plus number is the fastest identification
          it can make exactly.
        </span>
      </p>

      {loading && <p className="mt-4 text-xs text-ink-mute">Searching…</p>}

      <ul className="mt-3 space-y-2">
        {hits.map((h) => (
          <li key={h.id} className="panel flex items-center gap-3 p-2.5">
            <div className="w-[52px] shrink-0">
              <CardArt src={h.image_small} alt={h.name} label={`#${h.number}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{h.name}</p>
              <p className="num truncate text-[11px] text-ink-mute">
                #{h.number} · {h.set_name}
              </p>
              <p className="num text-xs font-semibold">{money(h.market_cents)}</p>
            </div>
            <button
              onClick={() =>
                onFound(
                  {
                    cardId: h.id,
                    variant: 'normal',
                    number: h.number,
                    name: h.name,
                    rarity: h.rarity,
                    imageSmall: h.image_small,
                    marketCents: h.market_cents,
                    acquisitionCents: h.market_cents,
                  },
                  null,
                )
              }
              className="btn-ghost min-h-[52px] shrink-0 px-3 text-xs"
            >
              Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
