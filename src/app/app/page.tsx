import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { buildInsights } from '@/lib/services/insights';
import { portfolioSummary } from '@/lib/services/collection';
import { unseenMilestones } from '@/lib/services/goals';
import { GoalHero } from '@/components/GoalHero';
import { MoveCard } from '@/components/MoveCard';
import { MilestoneToast, type MilestonePayload } from '@/components/MilestoneToast';
import { Empty, Money, Progress, SectionTitle, SourceNote } from '@/components/ui';
import { GOAL_MODES, type MilestoneKind } from '@/lib/domain/goals';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const user = await requireUser();
  const db = getDb();

  const insights = buildInsights(db, user.id);
  const portfolio = portfolioSummary(db, user.id);

  // Focus follows intent: a pinned set wins, otherwise the set closest to done
  // that is not yet finished — that is the one a collector is actually chasing.
  const active = insights.views.filter((v) => v.metrics.missingCount > 0);
  const hero =
    insights.views.find((v) => v.goal.pinned === 1) ??
    [...active].sort((a, b) => b.metrics.percent - a.metrics.percent)[0] ??
    insights.views[0];

  const others = insights.views.filter((v) => v.goal.id !== hero?.goal.id);
  const totalNeed = insights.views.reduce((s, v) => s + v.metrics.needCents, 0);

  const milestones: MilestonePayload[] = unseenMilestones(db, user.id).map((m) => {
    const p = m.payload ? JSON.parse(m.payload) : {};
    const view = insights.views.find((v) => v.goal.id === m.goal_id);
    return {
      kind: m.kind as MilestoneKind,
      setName: view?.set.name ?? 'your set',
      percent: p.percent ?? 0,
      ownedCount: p.ownedCount ?? 0,
      requiredCount: p.requiredCount ?? 0,
      completeCents: p.completeCents ?? 0,
    };
  });

  return (
    <>
      <header className="flex items-center justify-between px-4 pb-2 pt-5">
        <div>
          <p className="text-[11px] uppercase tracking-[.16em] text-ink-mute">
            {greeting()}, {user.display_name.split(' ')[0]}
          </p>
          <Link href="/" className="text-lg font-black tracking-tight">
            SET<span className="text-need">VALUE</span>
          </Link>
        </div>
        <Link
          href="/app/profile"
          aria-label="Profile and settings"
          className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-ink"
          style={{ background: user.avatar_color }}
        >
          {user.display_name.slice(0, 1).toUpperCase()}
        </Link>
      </header>

      <main className="space-y-6 px-4 pb-6">
        {hero ? (
          <GoalHero view={hero} />
        ) : (
          <Empty
            title="Pick a set to chase"
            body="SetValue answers what you need the moment it knows what you are trying to finish. Choose a set and the number appears immediately."
            action={{ href: '/app/sets', label: 'Browse sets' }}
          />
        )}

        {insights.moves.length > 0 && (
          <section>
            <SectionTitle
              action={
                <Link href="/app/moves" className="text-xs font-semibold text-ink-mute underline">
                  All moves
                </Link>
              }
            >
              Next Best Move
            </SectionTitle>
            <div className="space-y-3">
              {insights.moves.slice(0, 3).map((m, i) => (
                <MoveCard key={`${m.kind}-${m.goalId ?? i}`} move={m} primary={i === 0} />
              ))}
            </div>
            {insights.historyTooShallow && (
              <SourceNote className="mt-3">
                Price-change alerts are off. Each card currently carries a single dated reading from
                its provider, and one reading is not a trend. The next price snapshot gives SetValue
                something to compare against, and change tracking switches itself on.
              </SourceNote>
            )}
          </section>
        )}

        {others.length > 0 && (
          <section>
            <SectionTitle
              action={
                <span className="num text-xs text-need">
                  <Money cents={totalNeed} /> across {insights.views.length} sets
                </span>
              }
            >
              Also tracking
            </SectionTitle>
            <ul className="space-y-2">
              {others.map((v) => {
                const mode = GOAL_MODES.find((g) => g.id === v.goal.mode)?.label;
                return (
                  <li key={v.goal.id}>
                    <Link
                      href={`/app/sets/${v.set.id}?mode=${v.goal.mode}`}
                      className="panel flex items-center gap-3 px-3.5 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{v.set.name}</p>
                        <p className="text-[11px] text-ink-mute">
                          {mode} · {v.metrics.ownedCount}/{v.metrics.requiredCount}
                        </p>
                        <Progress
                          value={v.metrics.percent}
                          tone={v.metrics.missingCount === 0 ? 'have' : 'need'}
                          className="mt-2"
                        />
                      </div>
                      <div className="shrink-0 text-right">
                        {v.metrics.missingCount === 0 ? (
                          <span className="text-xs font-bold text-have">DONE</span>
                        ) : (
                          <>
                            <Money cents={v.metrics.needCents} className="block text-sm font-bold text-need" />
                            <span className="num text-[10px] text-ink-mute">
                              {(v.metrics.percent * 100).toFixed(1)}%
                            </span>
                          </>
                        )}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section>
          <SectionTitle
            action={
              <Link href="/app/collection" className="text-xs font-semibold text-ink-mute underline">
                Open collection
              </Link>
            }
          >
            Portfolio
          </SectionTitle>
          <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-ink-line">
            <Cell label="Collection value" value={<Money cents={portfolio.valueCents} />} tone="have" />
            <Cell label="Cards" value={portfolio.totalCards.toLocaleString()} sub={`${portfolio.uniqueCards.toLocaleString()} unique`} />
            <Cell
              label="Spent"
              value={portfolio.cardsWithCost > 0 ? <Money cents={portfolio.costBasisCents} /> : '—'}
              sub={portfolio.cardsWithCost > 0 ? `on ${portfolio.cardsWithCost} cards` : 'no purchase prices logged'}
            />
            <Cell
              label="Duplicates"
              value={portfolio.duplicateCopies.toLocaleString()}
              sub={portfolio.duplicateCopies > 0 ? <Money cents={portfolio.duplicateValueCents} /> : 'none'}
            />
          </div>
          <SourceNote className="mt-2">
            {portfolio.unpricedCards > 0
              ? `${portfolio.pricedCards.toLocaleString()} of ${portfolio.totalCards.toLocaleString()} cards carry a market price; ${portfolio.unpricedCards.toLocaleString()} have none and are excluded rather than counted as zero.`
              : 'Every card in your collection has a current market price.'}{' '}
            Played copies are discounted from Near Mint market value.
          </SourceNote>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <Link href="/app/journey" className="btn-ghost">Your journey</Link>
          <Link href="/app/binder" className="btn-ghost">Binder view</Link>
        </div>
      </main>

      <MilestoneToast milestones={milestones} />
    </>
  );
}

function Cell({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'have';
}) {
  return (
    <div className="bg-ink-soft px-4 py-3">
      <p className="label">{label}</p>
      <p className={`num mt-0.5 text-lg font-bold ${tone === 'have' ? 'text-have' : ''}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-ink-mute">{sub}</p>}
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
