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
 * situation Card Show mode runs in: a convention hall with 4,000 people on one
 * cell tower is the *normal* case for this screen, not an edge case. A card
 * with no artwork still has to be identifiable, tappable and correctly sized.
 *
 * Four details make that work:
 *
 *   * The slot is a wrapper with the card aspect ratio and the image is
 *     absolutely positioned inside it. The box therefore exists before, during
 *     and after loading, and a grid never reflows as art arrives or fails.
 *   * Images can finish — or fail — before React hydrates, and an `onError`
 *     attached after the fact never fires. On mount the component asks the
 *     element whether it already failed, which is the only way to catch the
 *     load that lost the race.
 *   * A badge (a variant tag) is drawn *by this component*, so when the
 *     placeholder is showing it takes a line in the stack instead of sitting on
 *     top of the card's name.
 *   * When the browser reports the connection is back, failed art is given
 *     another chance rather than staying a placeholder until the next
 *     navigation.
 */
export function CardArt({
  src,
  alt,
  owned = true,
  className = '',
  priority = false,
  label,
  badge,
}: {
  src: string | null;
  alt: string;
  owned?: boolean;
  className?: string;
  priority?: boolean;
  /**
   * A secondary identifier — usually the card number — shown under the name
   * when art is unavailable. Leave it out wherever the caption beside the
   * thumbnail already carries the number, or the placeholder repeats it.
   */
  label?: string;
  /** Variant tag. Overlays the art; joins the stack on the placeholder. */
  badge?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setFailed(false);
    const img = ref.current;
    // `complete` with no intrinsic width means the load already failed.
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, [src]);

  useEffect(() => {
    if (!failed || !src) return;
    const retry = () => setFailed(false);
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [failed, src]);

  const showPlaceholder = !src || failed;

  return (
    <div
      className={`card-art relative overflow-hidden rounded-lg border ${
        showPlaceholder ? 'border-dashed border-ink-line/80 bg-ink' : 'border-ink-line bg-ink-soft'
      } ${owned ? '' : 'opacity-90'} ${className}`}
    >
      {showPlaceholder ? (
        <div
          className={`absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center ${
            owned ? '' : 'opacity-60'
          }`}
        >
          {badge && (
            <span className="num rounded bg-ink-raise px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-gold">
              {badge}
            </span>
          )}
          <span className="line-clamp-2 w-full text-[10px] font-semibold leading-tight text-ink-mute">
            {alt}
          </span>
          {label && <span className="num text-[9px] text-ink-dim">{label}</span>}
        </div>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
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
          {badge && (
            <span className="num absolute bottom-1 left-1 rounded bg-ink/85 px-1 py-0.5 text-[8px] font-bold uppercase tracking-wide text-gold backdrop-blur">
              {badge}
            </span>
          )}
        </>
      )}
    </div>
  );
}
