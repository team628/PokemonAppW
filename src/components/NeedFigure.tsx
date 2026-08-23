'use client';

import { useEffect, useRef, useState } from 'react';
import { money } from '@/lib/pricing/quote';

/**
 * The signature number, animated.
 *
 * NEED is the number a collector watches. When a card is acquired it should
 * visibly *fall* — that drop is the reward for the action, and a number that
 * simply blinks to a new value throws the moment away.
 *
 * The animation is driven off the value itself rather than a timer, so it is
 * correct even when several cards land in quick succession: each change
 * re-targets from wherever the tween currently is. `prefers-reduced-motion`
 * skips straight to the final value.
 */
export function NeedFigure({
  cents,
  className = '',
  duration = 620,
}: {
  cents: number;
  className?: string;
  duration?: number;
}) {
  const [shown, setShown] = useState(cents);
  const frame = useRef<number | null>(null);
  const from = useRef(cents);
  const start = useRef(0);
  const [dropped, setDropped] = useState(false);

  useEffect(() => {
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      setShown(cents);
      return;
    }

    from.current = shown;
    start.current = performance.now();
    const delta = cents - from.current;
    if (delta === 0) return;
    if (delta < 0) {
      setDropped(true);
      const t = setTimeout(() => setDropped(false), 700);
      // Cleared below alongside the frame.
      frame.current !== null && cancelAnimationFrame(frame.current);
      const tick = (now: number) => {
        const p = Math.min(1, (now - start.current) / duration);
        // Ease-out cubic: fast commitment, gentle settle.
        const eased = 1 - Math.pow(1 - p, 3);
        setShown(Math.round(from.current + delta * eased));
        if (p < 1) frame.current = requestAnimationFrame(tick);
      };
      frame.current = requestAnimationFrame(tick);
      return () => {
        clearTimeout(t);
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      };
    }

    const tick = (now: number) => {
      const p = Math.min(1, (now - start.current) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(from.current + delta * eased));
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents]);

  return (
    <span
      className={`figure tabular-nums transition-colors duration-300 ${dropped ? 'text-have' : ''} ${className}`}
      aria-live="polite"
    >
      {money(shown)}
    </span>
  );
}
