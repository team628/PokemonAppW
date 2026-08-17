'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { GoalMode } from '@/lib/domain/goals';

export function TrackButton({
  setId,
  mode,
  tracked,
  goalId,
}: {
  setId: string;
  mode: GoalMode;
  tracked: boolean;
  goalId?: string;
}) {
  const router = useRouter();
  const [isTracked, setTracked] = useState(tracked);
  const [pending, start] = useTransition();

  function toggle() {
    start(async () => {
      const next = !isTracked;
      setTracked(next);
      if (next) {
        await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ setId, mode }),
        });
      } else if (goalId) {
        await fetch(`/api/goals/${goalId}`, { method: 'DELETE' });
      }
      router.refresh();
    });
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      aria-pressed={isTracked}
      className={`shrink-0 rounded-xl px-3 py-2 text-xs font-bold transition ${
        isTracked ? 'bg-have/15 text-have' : 'bg-white text-ink'
      }`}
    >
      {isTracked ? 'Tracking' : 'Track set'}
    </button>
  );
}
