import Link from 'next/link';
import { Money, Progress } from './ui';
import type { GoalView } from '@/lib/services/pg';
import { GOAL_MODES } from '@/lib/domain/goals';

/**
 * A tracked set, as an object rather than a row.
 *
 * The set's own logo carries the recognition — a collector knows Evolving Skies
 * by its wordmark long before they read it — so the artwork leads and the
 * figures support it. Falls back to the set name set in type when a logo is
 * missing, which is common for older and promo sets.
 */
export function SetCard({ view: v }: { view: GoalView }) {
  const done = v.missingCount === 0 && v.requiredCount > 0;
  const mode = GOAL_MODES.find((g) => g.id === v.mode)?.label ?? v.mode;

  return (
    <Link
      href={`/app/sets/${v.setId}?mode=${v.mode}`}
      className="panel group relative block overflow-hidden transition active:scale-[.99]"
    >
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 ${
          done ? 'bg-gradient-to-r from-have/[.07]' : 'bg-gradient-to-r from-need/[.05]'
        } to-transparent`}
      />
      <div className="relative flex items-center gap-3.5 px-3.5 py-3">
        <div className="flex h-12 w-14 shrink-0 items-center justify-center">
          {v.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={v.logoUrl}
              alt=""
              aria-hidden
              loading="lazy"
              decoding="async"
              className="max-h-12 w-full object-contain"
            />
          ) : v.symbolUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.symbolUrl} alt="" aria-hidden loading="lazy" className="h-7 w-7 object-contain opacity-80" />
          ) : (
            <span className="text-center text-[10px] font-black uppercase leading-tight tracking-wider text-ink-mute">
              {v.setName.slice(0, 12)}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold leading-tight">{v.setName}</p>
          <p className="num mt-0.5 text-[10px] uppercase tracking-wider text-ink-mute">
            {mode} · {v.ownedCount}/{v.requiredCount}
          </p>
          <Progress
            value={v.percent}
            tone={done ? 'have' : 'need'}
            height="h-1.5"
            className="mt-2"
          />
        </div>

        <div className="shrink-0 text-right">
          {done ? (
            <span className="text-[11px] font-black uppercase tracking-wider text-have">Done</span>
          ) : (
            <>
              <Money cents={v.needCents} className="block text-[15px] font-bold text-need" />
              <span className="num text-[10px] text-ink-mute">{(v.percent * 100).toFixed(0)}%</span>
            </>
          )}
        </div>
      </div>
    </Link>
  );
}
