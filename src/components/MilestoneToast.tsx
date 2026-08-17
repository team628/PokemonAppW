'use client';

import { useEffect, useState } from 'react';
import { MILESTONE_COPY, type MilestoneKind } from '@/lib/domain/goals';
import { money } from '@/lib/pricing/quote';

export interface MilestonePayload {
  kind: MilestoneKind;
  setName: string;
  percent: number;
  ownedCount: number;
  requiredCount: number;
  completeCents: number;
}

/**
 * The moment a set is finished is the emotional payoff of years of collecting.
 * It gets a full-screen interruption; a 50% milestone gets a quiet banner.
 * Anything that fires for every card would train people to dismiss the one that
 * actually matters.
 */
export function MilestoneToast({ milestones }: { milestones: MilestonePayload[] }) {
  const [queue, setQueue] = useState(milestones);
  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    fetch('/api/milestones/seen', { method: 'POST' }).catch(() => {});
  }, [current]);

  if (!current) return null;
  const copy = MILESTONE_COPY[current.kind];
  const isBig = current.kind === 'complete' || current.kind === 'one_left';
  const dismiss = () => setQueue((q) => q.slice(1));

  if (!isBig) {
    return (
      <div className="animate-slideUp fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md">
        <div className="panel flex items-center gap-3 border-gold/40 bg-ink-soft px-4 py-3 shadow-2xl">
          <span aria-hidden className="text-xl">🏅</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">{copy.title}</p>
            <p className="truncate text-xs text-ink-mute">
              {current.setName} · {copy.body}
            </p>
          </div>
          <button onClick={dismiss} className="text-xs font-semibold text-ink-mute" aria-label="Dismiss">
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={copy.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 px-6 backdrop-blur-sm"
    >
      {current.kind === 'complete' && <Confetti />}
      <div className="animate-pop w-full max-w-sm text-center">
        <p className="text-6xl" aria-hidden>
          {current.kind === 'complete' ? '🏆' : '🎯'}
        </p>
        <h2 className="mt-5 text-3xl font-black uppercase tracking-tight">
          {current.kind === 'complete' ? 'Set Complete' : 'One Left'}
        </h2>
        <p className="mt-2 text-lg font-bold">{current.setName}</p>
        <p className="mt-3 text-sm leading-relaxed text-ink-mute">{copy.body}</p>

        {current.kind === 'complete' && (
          <div className="panel mt-6 grid grid-cols-2 gap-px overflow-hidden bg-ink-line">
            <div className="bg-ink-soft px-4 py-3">
              <p className="label">Cards</p>
              <p className="num mt-0.5 text-lg font-bold">{current.requiredCount}</p>
            </div>
            <div className="bg-ink-soft px-4 py-3">
              <p className="label">Set value</p>
              <p className="num mt-0.5 text-lg font-bold text-have">{money(current.completeCents)}</p>
            </div>
          </div>
        )}

        <button onClick={dismiss} className="btn-primary mt-6 w-full">
          {current.kind === 'complete' ? 'Celebrate' : 'Go finish it'}
        </button>
      </div>
    </div>
  );
}

function Confetti() {
  const colors = ['#FFC93C', '#2DD4A7', '#FF8A3D', '#7C9CFF', '#F472B6'];
  const pieces = Array.from({ length: 44 }, (_, i) => ({
    left: (i * 37) % 100,
    delay: (i % 11) * 0.12,
    duration: 2.4 + ((i * 7) % 15) / 10,
    color: colors[i % colors.length]!,
  }));
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 overflow-hidden">
      {pieces.map((p, i) => (
        <span
          key={i}
          className="confetti-piece"
          style={{
            left: `${p.left}%`,
            background: p.color,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.duration}s`,
          }}
        />
      ))}
    </div>
  );
}
