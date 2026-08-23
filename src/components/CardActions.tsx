'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CONDITIONS, CONDITION_LABEL, type Condition } from '@/lib/domain/conditions';
import type { GoalMode } from '@/lib/domain/goals';

export function CardActions({
  cardId,
  variant,
  owned,
  mode,
}: {
  cardId: string;
  variant: string;
  owned: number;
  setId: string;
  mode: GoalMode;
}) {
  const router = useRouter();
  const [count, setCount] = useState(owned);
  const [condition, setCondition] = useState<Condition>('NM');
  const [paid, setPaid] = useState('');
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function mutate(direction: 'add' | 'remove') {
    setError(null);
    const optimistic = direction === 'add' ? count + 1 : Math.max(0, count - 1);
    setCount(optimistic);
    start(async () => {
      try {
        const res = await fetch(`/api/collection/${direction}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cardId,
            variant,
            quantity: 1,
            condition,
            withMode: mode,
            ...(direction === 'add' && paid.trim()
              ? { paidCents: Math.round(parseFloat(paid) * 100) }
              : {}),
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'Could not save');
        setPaid('');
        router.refresh();
      } catch (e) {
        setCount(count);
        setError(e instanceof Error ? e.message : 'Could not save that change.');
      }
    });
  }

  return (
    <div className="mt-3 border-t border-ink-line pt-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => mutate('remove')}
          disabled={pending || count === 0}
          aria-label="Remove one copy"
          className="btn-ghost h-11 w-11 px-0 text-lg"
        >
          −
        </button>
        <div className="flex-1 text-center">
          <p className="num text-lg font-bold">{count}</p>
          <p className="text-[10px] text-ink-mute">in collection</p>
        </div>
        <button
          onClick={() => mutate('add')}
          disabled={pending}
          aria-label="Add one copy"
          className="btn-need h-11 flex-1"
        >
          {count > 0 ? 'Add another' : 'I have this'}
        </button>
      </div>

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="mt-2 w-full text-center text-[11px] font-semibold text-ink-mute underline"
      >
        {open ? 'Hide details' : 'Condition & price paid'}
      </button>

      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="col-span-2 rounded-lg border border-ink-line bg-ink px-3 py-2">
            <p className="text-[11px] leading-relaxed text-ink-mute">
              Logging a card as graded keeps it in your collection and counts it toward set
              completion, but SetValue will not put a value on it — a slab and a raw copy trade at
              completely different prices and there is no graded price source here.
            </p>
          </div>
          <div>
            <label className="label" htmlFor={`cond-${cardId}-${variant}`}>Condition</label>
            <select
              id={`cond-${cardId}-${variant}`}
              value={condition}
              onChange={(e) => setCondition(e.target.value as Condition)}
              className="field mt-1 py-2.5"
            >
              {CONDITIONS.map((c) => (
                <option key={c} value={c}>{CONDITION_LABEL[c]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor={`paid-${cardId}-${variant}`}>Paid</label>
            <input
              id={`paid-${cardId}-${variant}`}
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={paid}
              onChange={(e) => setPaid(e.target.value)}
              placeholder="0.00"
              className="field mt-1 py-2.5"
            />
          </div>
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-[11px] text-need">{error}</p>}
    </div>
  );
}
