import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { buildInsights, unseenMilestones } from '@/lib/services/pg';
import { portfolioSummary } from '@/lib/services/pg/collection';
import { GoalHero } from '@/components/GoalHero';
import { MoveCard } from '@/components/MoveCard';
import { SetCard } from '@/components/SetCard';
import { CardTile } from '@/components/CardTile';
import { MilestoneToast, type MilestonePayload } from '@/components/MilestoneToast';
import { Disclosure, Empty, Money, SectionTitle } from '@/components/ui';
import type { MilestoneKind } from '@/lib/domain/goals';

export const dynamic = 'force-dynamic';

/** How many of the hero set's missing cards to put on the rail. */
const STRIP = 18;

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

  // The cards standing between this collector and a finished set. Already in
  // memory: `buildInsights` loads the missing printings behind every goal for
  // the move engine, in set order, so the rail is a slice rather than a second
  // trip to the database for the same rows.
  const strip = hero ? (insights.missingByGoal.get(hero.goalId) ?? []).slice(0, STRIP) : [];

  const milestones: MilestonePayload[] = milestoneRows.map((m) => {
    const p = (m.payload ?? {}) as Record<string, number>;
    const requiredCount = p.requiredCount ?? 0;
    return {
      kind: m.kind as MilestoneKind,
      setName: m.set_name,
      percent: requiredCount ? (p.ownedCount ?? 0) / requiredCount : 0,
      ownedCount: p.ownedCount ?? 0,
      requiredCount,
      completeCents: p.completeCents ?? 0,
      // The completion card is drawn from the milestone the database recorded,
      // so it says what was true at the moment the set was finished rather than
      // what happens to be true now.
      completion: {
        setId: m.set_id,
        setName: m.set_name,
        series: m.series,
        logoUrl: m.logo_url,
        cardCount: requiredCount,
        mode: m.mode,
        completedAt: m.completed_at ?? m.achieved_at,
        completeCents: p.completeCents ?? 0,
        collector: m.collector,
      },
    };
  });

  return (
    <>
      <header className="flex items-center justify-between px-4 pb-3 pt-5">
        <div>
          <p className="text-[10px] uppercase tracking-[.18em] text-ink-mute">{greeting()}</p>
          <Link href="/" className="text-lg font-black tracking-tight">
            SET<span className="text-need">VALUE</span>
          </Link>
        </div>
        <Link
          href="/app/profile"
          aria-label="Profile and settings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-have text-sm font-bold text-ink"
        >
          {(user.email ?? 'C').slice(0, 1).toUpperCase()}
        </Link>
      </header>

      <main className="space-y-7 px-4 pb-6">
        {hero ? (
          <GoalHero view={hero} />
        ) : (
          <Empty
            title="Pick a set to chase"
            body="SetValue answers what you need the moment it knows what you are trying to finish."
            action={{ href: '/app/sets', label: 'Browse sets' }}
          />
        )}

        {hero && strip.length > 0 && (
          <section>
            <SectionTitle
              action={
                <Link
                  href={`/app/sets/${hero.setId}?mode=${hero.mode}&filter=missing`}
                  className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
                >
                  All {hero.missingCount}
                </Link>
              }
            >
              Still hunting
            </SectionTitle>
            <ul className="rail rail-bleed flex gap-2.5 overflow-x-auto pb-1">
              {strip.map((c) => (
                <li key={`${c.cardId}-${c.variant}`} className="shrink-0">
                  <CardTile
                    card={{
                      cardId: c.cardId,
                      name: c.name,
                      number: c.number,
                      variant: c.variant,
                      imageSmall: c.imageSmall,
                      marketCents: c.marketCents,
                      owned: false,
                    }}
                    width="w-[78px]"
                    href={`/app/cards/${c.cardId}`}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {insights.moves.length > 0 && (
          <section>
            <SectionTitle
              action={
                <Link
                  href="/app/moves"
                  className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
                >
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
              <Disclosure summary="Price-change alerts are off" className="mt-3">
                Each card currently carries a single dated reading from its provider, and one
                reading is not a trend. The next snapshot gives SetValue something to compare
                against.
              </Disclosure>
            )}
          </section>
        )}

        {others.length > 0 && (
          <section>
            <SectionTitle
              action={
                <span className="num text-[11px] font-semibold text-need">
                  <Money cents={totalNeed} /> across {insights.goals.length}
                </span>
              }
            >
              Also tracking
            </SectionTitle>
            <ul className="space-y-2">
              {others.map((v) => (
                <li key={v.goalId}>
                  <SetCard view={v} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionTitle
            action={
              <Link
                href="/app/collection"
                className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
              >
                Open collection
              </Link>
            }
          >
            Portfolio
          </SectionTitle>
          <div className="panel flex items-center gap-4 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="label">Collection value</p>
              <Money
                cents={portfolio.estimatedValueCents}
                className="mt-1 block text-2xl font-extrabold text-have"
              />
            </div>
            <div className="shrink-0 border-l border-ink-line pl-4 text-right">
              <p className="num text-[15px] font-bold">{portfolio.totalCards.toLocaleString()}</p>
              <p className="text-[10px] text-ink-mute">cards</p>
              <p className="num mt-1.5 text-[15px] font-bold">{portfolio.setsTouched}</p>
              <p className="text-[10px] text-ink-mute">sets</p>
            </div>
          </div>
          <Disclosure summary="How collection value is worked out" className="mt-2.5">
            A condition-adjusted estimate built from observed market prices (observed total{' '}
            <Money cents={portfolio.observedValueCents} />).
            {portfolio.unpricedCards > 0 && (
              <> {portfolio.unpricedCards} cards have no market price and are excluded rather than counted as zero.</>
            )}
            {portfolio.gradedCards > 0 && (
              <> {portfolio.gradedCards} graded cards are held but not valued — a slab and a raw copy are different objects to the market.</>
            )}
            {portfolio.duplicateCopies > 0 && <> {portfolio.duplicateCopies} spare copies.</>}
          </Disclosure>
        </section>

        <div className="grid grid-cols-2 gap-2">
          <Link href="/app/journey" className="btn-ghost">
            Your journey
          </Link>
          <Link href="/app/binder" className="btn-ghost">
            Binder view
          </Link>
        </div>
      </main>

      <MilestoneToast milestones={milestones} />
    </>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
