'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { money } from '@/lib/pricing/quote';

interface Summary {
  finds: number;
  spentCents: number;
  marketCents: number;
  edgeCents: number | null;
  pricedFinds: number;
}

export function EndHuntButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, start] = useTransition();

  function end() {
    start(async () => {
      const res = await fetch('/api/show/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'end', sessionId }),
      });
      const data = await res.json();
      setSummary(data.summary ?? null);
    });
  }

  return (
    <>
      <button
        onClick={end}
        disabled={pending}
        className="shrink-0 rounded-xl border border-ink-line px-3 py-2 text-xs font-bold text-ink-mute"
      >
        End hunt
      </button>

      {summary && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hunt summary"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 px-6"
        >
          <div className="animate-pop w-full max-w-sm text-center">
            <p className="text-5xl" aria-hidden>🎒</p>
            <h2 className="mt-4 text-2xl font-black">Hunt logged</h2>
            <p className="num mt-1 text-sm text-ink-mute">
              {summary.finds} card{summary.finds === 1 ? '' : 's'} added to your collection
            </p>

            <div className="panel mt-5 grid grid-cols-2 gap-px overflow-hidden bg-ink-line text-left">
              <div className="bg-ink-soft px-4 py-3">
                <p className="label">Spent</p>
                <p className="num mt-0.5 text-lg font-bold">{money(summary.spentCents)}</p>
              </div>
              <div className="bg-ink-soft px-4 py-3">
                <p className="label">Market value</p>
                <p className="num mt-0.5 text-lg font-bold text-have">{money(summary.marketCents)}</p>
              </div>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-ink-mute">
              {summary.edgeCents === null
                ? 'No purchase prices were logged on this hunt, so there is nothing to compare against market.'
                : summary.edgeCents >= 0
                  ? `You paid ${money(summary.edgeCents)} under market across the ${summary.pricedFinds} card${summary.pricedFinds === 1 ? '' : 's'} where you logged a price.`
                  : `You paid ${money(-summary.edgeCents)} over market across the ${summary.pricedFinds} card${summary.pricedFinds === 1 ? '' : 's'} where you logged a price.`}
            </p>

            <button
              onClick={() => {
                setSummary(null);
                router.push('/app');
                router.refresh();
              }}
              className="btn-primary mt-5 w-full"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );
}
