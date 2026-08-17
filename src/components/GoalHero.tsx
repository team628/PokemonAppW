import Link from 'next/link';
import { Money, Progress, SourceNote } from './ui';
import { money } from '@/lib/pricing/quote';
import type { GoalView } from '@/lib/services/pg';
import { GOAL_MODES } from '@/lib/domain/goals';

/**
 * The signature screen.
 *
 * One number dominates: what it will take to finish. Everything else on the
 * panel exists to make that number trustworthy — the percentage it moves, the
 * two totals it sits between, and the line at the bottom saying where it came
 * from.
 */
export function GoalHero({ view: m }: { view: GoalView }) {
  const modeLabel = GOAL_MODES.find((x) => x.id === m.mode)?.label ?? m.mode;
  const done = m.missingCount === 0 && m.requiredCount > 0;

  return (
    <section className="panel relative overflow-hidden px-5 pb-5 pt-5">
      {m.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={m.logoUrl}
          alt=""
          aria-hidden
          className="pointer-events-none absolute -right-6 -top-4 h-24 opacity-[0.07]"
        />
      )}

      <div className="flex items-baseline justify-between gap-3">
        <Link href={`/app/sets/${m.setId}?mode=${m.mode}`} className="min-w-0">
          <p className="truncate text-sm font-bold">{m.setName}</p>
          <p className="text-[11px] uppercase tracking-[.14em] text-ink-mute">
            {modeLabel} · {m.series}
          </p>
        </Link>
        {m.pinned && <span className="chip shrink-0 text-gold">Pinned</span>}
      </div>

      {done ? (
        <div className="mt-5">
          <p className="num text-5xl font-black leading-none text-have">$0</p>
          <p className="mt-2 text-sm font-bold text-have">SET COMPLETE</p>
          <p className="mt-1 text-xs text-ink-mute">
            All {m.requiredCount} cards accounted for. Finished{' '}
            {m.completedAt ? new Date(m.completedAt).toLocaleDateString() : 'recently'}.
          </p>
        </div>
      ) : (
        <div className="mt-5">
          <p className="num text-[3.25rem] font-black leading-none tracking-tight text-need">
            {money(m.needCents)}
          </p>
          <p className="mt-1 text-[11px] font-bold uppercase tracking-[.2em] text-need/80">
            {m.needIsFloor ? 'To go (at least)' : 'To go'}
          </p>
        </div>
      )}

      <div className="mt-4">
        <Progress value={m.percent} tone={done ? 'have' : 'need'} />
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="num font-semibold">
            {(m.percent * 100).toFixed(1)}% complete
          </span>
          <span className="num text-ink-mute">
            {m.ownedCount}/{m.requiredCount} · {m.missingCount} remaining
          </span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-ink-line bg-ink px-3 py-2.5">
          <p className="label">Have</p>
          <Money cents={m.haveCents} className="mt-0.5 block text-lg font-bold text-have" />
        </div>
        <div className="rounded-xl border border-ink-line bg-ink px-3 py-2.5">
          <p className="label">Complete</p>
          <Money cents={m.completeCents} className="mt-0.5 block text-lg font-bold" />
        </div>
      </div>

      {!done && (
        <div className="mt-3 flex gap-2">
          <Link href={`/app/sets/${m.setId}?mode=${m.mode}&filter=missing`} className="btn-need flex-1">
            See what&apos;s missing
          </Link>
          <Link
            href={`/app/show?set=${m.setId}`}
            className="btn-ghost shrink-0"
            aria-label="Open Card Show mode for this set"
          >
            Card Show
          </Link>
        </div>
      )}

      <SourceNote className="mt-3 border-t border-ink-line pt-3">
        HAVE and COMPLETE are TCGplayer market values in USD; TO GO is the difference, so the three
        always reconcile.{' '}
        {m.pricedMissing + m.unpricedMissing > 0 && (
          <>
            {m.pricedMissing} of {m.missingCount} missing cards have a current price
            {m.unpricedMissing > 0 && `, ${m.unpricedMissing} have none — TO GO is a floor`}.{' '}
          </>
        )}
        {m.oldestObservation && <>Oldest reading {String(m.oldestObservation).slice(0, 10)}.</>}
        {m.variantConfidence < 0.99 && (
          <> {(100 - m.variantConfidence * 100).toFixed(0)}% of printings inferred from set era and rarity rather than market listings.</>
        )}
      </SourceNote>
    </section>
  );
}
