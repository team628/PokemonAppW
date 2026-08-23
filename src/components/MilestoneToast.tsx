'use client';

import { useEffect, useState } from 'react';
import { MILESTONE_COPY, type MilestoneKind } from '@/lib/domain/goals';
import { CompletionMoment } from './CompletionMoment';
import type { CompletionCardData } from './CompletionCard';

export interface MilestonePayload {
  kind: MilestoneKind;
  setName: string;
  percent: number;
  ownedCount: number;
  requiredCount: number;
  completeCents: number;
  /** Present on every milestone; only a completion draws the card. */
  completion: CompletionCardData;
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
  const dismiss = () => setQueue((q) => q.slice(1));

  // A finished set gets the signature moment. Everything else gets a banner —
  // if every milestone interrupted, people would learn to dismiss the one that
  // actually matters.
  if (current.kind === 'complete') {
    return <CompletionMoment data={current.completion} onDismiss={dismiss} />;
  }

  if (current.kind === 'one_left') {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={copy.title}
        className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 px-6 backdrop-blur-sm"
      >
        <div className="animate-pop w-full max-w-sm text-center">
          <p className="text-[11px] font-bold uppercase tracking-[.34em] text-need">One left</p>
          <h2 className="mt-4 text-3xl font-black leading-tight tracking-tight">
            {current.setName}
          </h2>
          <p className="num mt-3 text-[13px] text-ink-mute">
            {current.ownedCount} of {current.requiredCount} · one card from finished
          </p>
          <p className="mt-4 text-sm leading-relaxed text-ink-mute">{copy.body}</p>
          <button onClick={dismiss} className="btn-primary mt-7 w-full">
            Go finish it
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-slideUp fixed inset-x-3 bottom-24 z-50 mx-auto max-w-md">
      <div className="panel flex items-center gap-3 border-gold/40 bg-ink-soft px-4 py-3 shadow-2xl">
        <span
          aria-hidden
          className="num flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-gold/40 text-[11px] font-black text-gold"
        >
          {Math.round(current.percent * 100)}%
        </span>
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
