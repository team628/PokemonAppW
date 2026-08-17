'use client';

import { useState } from 'react';

/**
 * Trading-card thumbnail.
 *
 * `owned={false}` desaturates — the visual language of a hole in a set.
 *
 * Art is loaded straight from the provider CDN so the app server never becomes
 * a proxy for the several hundred images on a set page. The cost of that choice
 * is that a flaky connection produces broken images, which is precisely the
 * situation Card Show mode runs in — so a failed load falls back to a legible
 * placeholder carrying the card's number rather than a broken-image icon.
 */
export function CardArt({
  src,
  alt,
  owned = true,
  className = '',
  priority = false,
  label,
}: {
  src: string | null;
  alt: string;
  owned?: boolean;
  className?: string;
  priority?: boolean;
  /** Shown on the placeholder when art is unavailable — usually the card number. */
  label?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <div
        className={`card-art flex flex-col items-center justify-center gap-0.5 rounded-lg border border-ink-line bg-ink px-1 text-center ${
          owned ? '' : 'opacity-60'
        } ${className}`}
      >
        <span className="num text-[10px] font-bold text-ink-mute">{label ?? '—'}</span>
        <span className="line-clamp-2 text-[9px] leading-tight text-ink-mute/70">{alt}</span>
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
      // The tile keeps a visible frame while the art is still in flight, so a
      // slow connection shows a card-shaped slot rather than a hole in the grid.
      className={`card-art w-full rounded-lg border border-ink-line bg-ink-soft object-cover ${
        owned ? '' : 'dim'
      } ${className}`}
    />
  );
}
