'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { money } from '@/lib/pricing/quote';
import { GOAL_MODES, type GoalMode } from '@/lib/domain/goals';

export interface OnboardSet {
  id: string;
  name: string;
  series: string;
  releaseDate: string | null;
  printedTotal: number;
  symbolUrl: string | null;
  mainSetCents: number;
}

/** Sets people most often say they are chasing, as the zero-typing starting point. */
const SUGGESTED = ['sv3pt5', 'base1', 'swsh7', 'sv1', 'xy12', 'sm12', 'swsh12pt5', 'sv8', 'neo1'];

export function Onboarding({ sets }: { sets: OnboardSet[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<Record<string, GoalMode>>({});
  const [pending, start] = useTransition();

  const suggested = useMemo(
    () => SUGGESTED.map((id) => sets.find((s) => s.id === id)).filter((s): s is OnboardSet => !!s),
    [sets],
  );

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return suggested;
    return sets.filter((s) => s.name.toLowerCase().includes(term)).slice(0, 24);
  }, [q, sets, suggested]);

  const count = Object.keys(chosen).length;

  function pick(id: string) {
    setChosen((prev) => {
      const next = { ...prev };
      if (next[id]) delete next[id];
      else next[id] = 'main';
      return next;
    });
  }

  function finish() {
    start(async () => {
      for (const [setId, mode] of Object.entries(chosen)) {
        await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setId, mode }),
        });
      }
      router.push('/app');
      router.refresh();
    });
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-32 pt-10">
      <p className="text-lg font-black tracking-tight">
        SET<span className="text-need">VALUE</span>
      </p>
      <h1 className="mt-6 text-2xl font-bold leading-tight">What are you chasing?</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-mute">
        Pick at least one set. SetValue works out what you still need, what it is worth, and the
        cheapest way to finish it. You can add more later, and change how complete &ldquo;complete&rdquo;
        means for each one.
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search 174 sets…"
        aria-label="Search sets"
        type="search"
        className="field mt-5"
      />

      {!q && <p className="label mt-5">Commonly chased</p>}

      <ul className="mt-3 space-y-2">
        {results.map((s) => {
          const selected = chosen[s.id];
          return (
            <li key={s.id} className={`panel px-3.5 py-3 ${selected ? 'border-need/50' : ''}`}>
              <button onClick={() => pick(s.id)} className="flex w-full items-center gap-3 text-left">
                {s.symbolUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.symbolUrl} alt="" aria-hidden className="h-7 w-7 shrink-0 object-contain" />
                ) : (
                  <span className="h-7 w-7 shrink-0 rounded bg-ink" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{s.name}</span>
                  <span className="num block text-[11px] text-ink-mute">
                    {s.releaseDate?.replace(/\//g, '.')} · {s.printedTotal} cards ·{' '}
                    {money(s.mainSetCents)}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-black ${
                    selected ? 'bg-need text-ink' : 'border border-ink-line text-ink-mute'
                  }`}
                >
                  {selected ? '✓' : '+'}
                </span>
              </button>

              {selected && (
                <div className="mt-2.5 flex gap-1.5 border-t border-ink-line pt-2.5">
                  {GOAL_MODES.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setChosen((p) => ({ ...p, [s.id]: m.id }))}
                      aria-pressed={selected === m.id}
                      className={`flex-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold ${
                        selected === m.id ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div
        className="fixed inset-x-0 bottom-0 border-t border-ink-line bg-ink/95 px-5 py-4 backdrop-blur"
        style={{ paddingBottom: 'calc(1rem + var(--safe-b))' }}
      >
        <div className="mx-auto max-w-2xl">
          <button onClick={finish} disabled={count === 0 || pending} className="btn-need w-full">
            {pending
              ? 'Setting up…'
              : count === 0
                ? 'Pick a set to continue'
                : `Track ${count} set${count === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </main>
  );
}
