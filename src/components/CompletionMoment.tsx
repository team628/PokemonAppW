'use client';

import { useEffect, useRef, useState } from 'react';
import { CompletionCard, type CompletionCardData } from './CompletionCard';

/**
 * The moment a set finishes.
 *
 * Fires on the transition into 100% and nowhere else. Two things guarantee
 * that, and they are the same two that guarantee the milestone is once-only:
 * the `milestones` row is inserted once per goal by the database, and it is
 * marked seen the first time it is shown. Reloading a finished set page does
 * not replay this, because there is no unseen row left to replay.
 *
 * The card inside the overlay is the same component a shareable completion card
 * will render, from the same data.
 */
export function CompletionMoment({
  data,
  onDismiss,
}: {
  data: CompletionCardData;
  onDismiss: () => void;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const [motion, setMotion] = useState(false);

  // Confetti is not rendered at all when the reader has asked for reduced
  // motion — the global reduced-motion rule would collapse the animation to
  // nothing anyway, and leaving 40 elements in the document to be invisible is
  // just litter.
  useEffect(() => {
    setMotion(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  useEffect(() => {
    dismissRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${data.setName} complete`}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-ink/95 px-5 py-8 backdrop-blur-md"
    >
      {motion && <Confetti />}
      <div className={`relative w-full max-w-sm sm:max-w-md ${motion ? 'animate-pop' : ''}`}>
        <CompletionCard data={data} />
        <button ref={dismissRef} onClick={onDismiss} className="btn-primary mt-5 w-full">
          Done
        </button>
        <p className="mt-3 text-center text-[11px] text-ink-mute">
          This card stays on your profile.
        </p>
      </div>
    </div>
  );
}

/**
 * Paper, not sparkles. The palette is SetValue's own — gold, have-green,
 * need-red and two neutrals — so the celebration reads as this product's rather
 * than as a generic party effect.
 */
function Confetti() {
  const colors = ['#FFC93C', '#2DD4A7', '#FF6B6B', '#7C9CFF', '#E8ECF4'];
  const pieces = Array.from({ length: 40 }, (_, i) => ({
    left: (i * 37) % 100,
    delay: (i % 11) * 0.11,
    duration: 2.6 + ((i * 7) % 15) / 10,
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
