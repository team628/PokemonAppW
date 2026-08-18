'use client';

import { useEffect, useRef, useState } from 'react';

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
 *
 * Two details make that fallback actually work:
 *
 *   * The slot is a wrapper with the card aspect ratio and the image is
 *     absolutely positioned inside it. The box therefore exists before, during
 *     and after loading, and a grid never reflows as art arrives or fails.
 *   * Images can finish — or fail — before React hydrates, and an `onError`
 *     attached after the fact never fires. On mount the component asks the
 *     element whether it already failed, which is the only way to catch the
 *     load that lost the race.
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
  const ref = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const img = ref.current;
    // `complete` with no intrinsic width means the load already failed.
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);

  const showPlaceholder = !src || failed;

  return (
    <div
      className={`card-art relative overflow-hidden rounded-lg border border-ink-line ${
        showPlaceholder ? 'bg-ink' : 'bg-ink-soft'
      } ${owned ? '' : 'opacity-90'} ${className}`}
    >
      {showPlaceholder ? (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center gap-0.5 px-1 text-center ${
            owned ? '' : 'opacity-60'
          }`}
        >
          <span className="num text-[10px] font-bold text-ink-mute">{label ?? '—'}</span>
          <span className="line-clamp-2 w-full text-[9px] leading-tight text-ink-mute/70">{alt}</span>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={ref}
          src={src}
          alt={alt}
          width={245}
          height={342}
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(true)}
          className={`absolute inset-0 h-full w-full object-cover ${owned ? '' : 'dim'}`}
        />
      )}
    </div>
  );
}
