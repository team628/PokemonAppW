import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { buildInsights, unseenMilestones } from '@/lib/services/pg';
import { portfolioSummary } from '@/lib/services/pg/collection';
import { GoalHero } from '@/components/GoalHero';
import { MoveCard } from '@/components/MoveCard';
import { MilestoneToast, type MilestonePayload } from '@/components/MilestoneToast';
import { Empty, Money, Progress, SectionTitle, SourceNote } from '@/components/ui';
import { GOAL_MODES, type MilestoneKind } from '@/lib/domain/goals';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const user = await requireUser();
  const [insights, portfolio, milestoneRows] = await Promise.all([
    buildInsights(user.id),
    portfolioSummary(user.id),
    unseenMilestones(user.id),
  ]);

  const active = insights.goals.filter((v) => v.missingCount > 0);
  const hero =
    insights.goals.find((v) => v.pinned) ??
    [...active].sort((a, b) => b.percent - a.percent)[0] ??
    insights.goals[0];
  const others = insights.goals.filter((v) => v.goalId !== hero?.goalId);
  const totalNeed = insights.goals.reduce((s, v) => s + v.needCents, 0);

  const milestones: MilestonePayload[] = milestoneRows.map((m) => {
    const p = (m.payload ?? {}) as Record<string, number>;
    return {
      kind: m.kind as MilestoneKind,
      setName: m.set_name,
      percent: p.requiredCount ? (p.ownedCount ?? 0) / p.requiredCount : 0,
      ownedCount: p.ownedCount ?? 0,
      requiredCount: p.requiredCount ?? 0,
      completeCents: p.completeCents ?? 0,
    };
  });

  return (
    <>
      <header className="flex items-center justify-between px-4 pb-2 pt-5">
        <div>
          <p className="text-[11px] uppercase tracking-[.16em] text-ink-mute">{greeting()}</p>
          <Link href="/" className="text-lg font-black tracking-tight">
            SET<span className="text-need">VALUE</span>
          </Link>
        </div>
        <Link href="/app/profile" aria-label="Profile and settings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-have text-sm font-bold text-ink">
          {(user.email ?? 'C').slice(0, 1).toUpperCase()}
        </Link>
      </header>

      <main className="space-y-6 px-4 pb-6">
        {hero ? <GoalHero view={hero} /> : (
          <Empty title="Pick a set to chase"
            body="SetValue answers what you need the moment it knows what you are trying to finish."
            action={{ href: '/app/sets', label: 'Browse sets' }} />
        )}

        {insights.moves.length > 0 && (
          <section>
            <SectionTitle action={<Link href="/app/moves" className="text-xs font-semibold text-ink-mute underline">All moves</Link>}>
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
                its provider, and one reading is not a trend. The next hourly snapshot gives SetValue
                something to compare against.
              </SourceNote>
            )}
          </section>
        )}

        {others.length > 0 && (
          <section>
            <SectionTitle action={<span className="num text-xs text-need"><Money cents={totalNeed} /> across {insights.goals.length} sets</span>}>
              Also tracking
            </SectionTitle>
            <ul className="space-y-2">
              {others.map((v) => (
                <li key={v.goalId}>
                  <Link href={`/app/sets/${v.setId}?mode=${v.mode}`} className="panel flex items-center gap-3 px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{v.setName}</p>
                      <p className="text-[11px] text-ink-mute">
                        {GOAL_MODES.find((g) => g.id === v.mode)?.label} · {v.ownedCount}/{v.requiredCount}
                      </p>
                      <Progress value={v.percent} tone={v.missingCount === 0 ? 'have' : 'need'} className="mt-2" />
                    </div>
                    <div className="shrink-0 text-right">
                      {v.missingCount === 0 ? <span className="text-xs font-bold text-have">DONE</span> : (
                        <>
                          <Money cents={v.needCents} className="block text-sm font-bold text-need" />
                          <span className="num text-[10px] text-ink-mute">{(v.percent * 100).toFixed(1)}%</span>
                        </>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionTitle action={<Link href="/app/collection" className="text-xs font-semibold text-ink-mute underline">Open collection</Link>}>
            Portfolio
          </SectionTitle>
          <div className="panel grid grid-cols-2 gap-px overflow-hidden bg-ink-line">
            <Cell label="Collection value" value={<Money cents={portfolio.estimatedValueCents} />} tone="have" />
            <Cell label="Cards" value={portfolio.totalCards.toLocaleString()} sub={`${portfolio.uniqueCards.toLocaleString()} unique`} />
            <Cell label="Spent" value={portfolio.cardsWithCost > 0 ? <Money cents={portfolio.costBasisCents} /> : '—'}
              sub={portfolio.cardsWithCost > 0 ? `on ${portfolio.cardsWithCost} cards` : 'no purchase prices logged'} />
            <Cell label="Duplicates" value={portfolio.duplicateCopies.toLocaleString()}
              sub={portfolio.gradedCards > 0 ? `${portfolio.gradedCards} graded, unvalued` : undefined} />
          </div>
          <SourceNote className="mt-2">
            Collection value is a condition-adjusted estimate built from observed market prices
            (observed total <Money cents={portfolio.observedValueCents} />).
            {portfolio.unpricedCards > 0 && ` ${portfolio.unpricedCards} cards have no market price and are excluded rather than counted as zero.`}
            {portfolio.gradedCards > 0 && ` ${portfolio.gradedCards} graded cards are held but not valued.`}
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

function Cell({ label, value, sub, tone = 'default' }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'default' | 'have';
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
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
