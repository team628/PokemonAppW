import Link from 'next/link';
import { Disclosure, Money, Ring } from './ui';
import { money } from '@/lib/pricing/quote';
import type { GoalView } from '@/lib/services/pg';
import { GOAL_MODES } from '@/lib/domain/goals';

/**
 * The signature panel.
 *
 * One number dominates: what it will take to finish. Everything else is
 * arranged around it — the ring says how far along, the pair beneath says what
 * the set is worth and what is already on the shelf, and the method behind all
 * three is one tap away rather than three paragraphs long.
 *
 * Deliberately holds exactly three money figures, in the order NEED, HAVE,
 * COMPLETE, because those three reconcile and reading them together is the
 * point of the panel.
 */
export function GoalHero({ view: m }: { view: GoalView }) {
  const modeLabel = GOAL_MODES.find((x) => x.id === m.mode)?.label ?? m.mode;
  const done = m.missingCount === 0 && m.requiredCount > 0;
  const pct = m.percent * 100;

  return (
    <section className="panel-raise relative overflow-hidden">
      {m.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={m.logoUrl}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-8 -top-6 h-32 opacity-[0.06]"
        />
      )}
      {/* A single warm wash behind the number, so NEED reads as the focal point
          without needing a heavier surface. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-x-0 top-0 h-40 ${
          done ? 'bg-gradient-to-b from-have/[.10]' : 'bg-gradient-to-b from-need/[.10]'
        } to-transparent`}
      />

      <div className="relative px-5 pb-5 pt-4">
        <div className="flex items-center justify-between gap-3">
          <Link href={`/app/sets/${m.setId}?mode=${m.mode}`} className="min-w-0">
            <p className="truncate text-[15px] font-bold leading-tight">{m.setName}</p>
            <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[.16em] text-ink-mute">
              {modeLabel}
            </p>
          </Link>
          {m.pinned && <span className="chip shrink-0 border-gold/40 text-gold">Pinned</span>}
        </div>

        <div className="mt-4 flex items-center gap-4">
          <div className="min-w-0 flex-1">
            {done ? (
              <>
                <p className="figure text-[3.4rem] text-have">$0</p>
                <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-have">
                  Set complete
                </p>
              </>
            ) : (
              <>
                <p className="figure text-[3.4rem] text-need">{money(m.needCents)}</p>
                <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-need/80">
                  {m.needIsFloor ? 'Left to complete · at least' : 'Left to complete'}
                </p>
              </>
            )}
          </div>

          <Ring value={m.percent} size={78} stroke={7} tone={done ? 'have' : 'need'}>
            <span className="num text-[17px] font-extrabold leading-none">{pct.toFixed(0)}%</span>
            <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-mute">
              done
            </span>
          </Ring>
        </div>

        <p className="num mt-3 text-[11px] text-ink-mute">
          <span className="font-semibold text-white">{pct.toFixed(1)}% complete</span>
          {' · '}
          {m.ownedCount}/{m.requiredCount} cards
          {!done && <> · {m.missingCount} remaining</>}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
            <p className="label">Have</p>
            <Money cents={m.haveCents} className="mt-1 block text-[17px] font-bold text-have" />
          </div>
          <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
            <p className="label">Complete</p>
            <Money cents={m.completeCents} className="mt-1 block text-[17px] font-bold" />
          </div>
        </div>

        {!done && (
          <div className="mt-3 flex gap-2">
            <Link
              href={`/app/sets/${m.setId}?mode=${m.mode}&filter=missing`}
              className="btn-need flex-1"
            >
              See what&apos;s missing
            </Link>
            <Link
              href={`/app/show?set=${m.setId}&mode=${m.mode}`}
              className="btn-ghost shrink-0"
              aria-label="Open Card Show mode for this set"
            >
              Card Show
            </Link>
          </div>
        )}

        <div className="mt-3.5 border-t border-ink-line pt-3">
          <Disclosure summary="TCGplayer market, USD — how this is worked out">
            HAVE and COMPLETE are TCGplayer market values; LEFT TO COMPLETE is the difference, so
            the three always reconcile.{' '}
            {m.pricedMissing + m.unpricedMissing > 0 && (
              <>
                {m.pricedMissing} of {m.missingCount} missing cards have a current price
                {m.unpricedMissing > 0 && (
                  <>
                    , {m.unpricedMissing} have none — so the figure is a floor, not a ceiling
                  </>
                )}
                .{' '}
              </>
            )}
            {m.oldestObservation && <>Oldest reading {String(m.oldestObservation).slice(0, 10)}. </>}
            {m.variantConfidence < 0.99 && (
              <>
                {(100 - m.variantConfidence * 100).toFixed(0)}% of printings are inferred from set
                era and rarity rather than confirmed by a market listing.
              </>
            )}
          </Disclosure>
        </div>
      </div>
    </section>
  );
}
