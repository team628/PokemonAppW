'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';

/**
 * Sharing control.
 *
 * A collection's total value is exactly the information that makes someone a
 * target, so publishing it is opt-in and reversible from one place. The link is
 * only shown once the page is actually public.
 */
export function ShareToggle({ handle, initial }: { handle: string; initial: boolean }) {
  const [isPublic, setPublic] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    const next = !isPublic;
    setError(null);
    setPublic(next);
    start(async () => {
      try {
        const res = await fetch('/api/profile/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isPublic: next }),
        });
        if (!res.ok) throw new Error('Could not save that.');
      } catch (e) {
        setPublic(!next);
        setError(e instanceof Error ? e.message : 'Could not save that.');
      }
    });
  }

  return (
    <div className="panel px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Public collection page</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-mute">
            {isPublic
              ? 'Anyone with the link can see your set progress and collection value.'
              : 'Off. Nobody can see your collection, and the link returns nothing.'}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={pending}
          role="switch"
          aria-checked={isPublic}
          aria-label="Make my collection page public"
          className={`relative h-7 w-12 shrink-0 rounded-full transition ${
            isPublic ? 'bg-have' : 'bg-white/15'
          }`}
        >
          <span
            aria-hidden
            className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${
              isPublic ? 'left-6' : 'left-1'
            }`}
          />
        </button>
      </div>

      {isPublic && (
        <Link href={`/c/${handle}`} className="mt-2.5 block break-all text-[11px] text-ink-mute underline">
          /c/{handle}
        </Link>
      )}

      <p className="mt-2 text-[11px] leading-relaxed text-ink-mute">
        Purchase prices, what you paid on a hunt, your email and your card locations are never shown
        on a public page, whether it is on or off.
      </p>

      {error && <p role="alert" className="mt-2 text-[11px] text-need">{error}</p>}
    </div>
  );
}
