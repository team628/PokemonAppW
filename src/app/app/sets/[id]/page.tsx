import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSet, primaryVariantMap, setRequirements } from '@/lib/repo/catalog';
import { GOAL_MODES, computeGoal, ownedIndex, requirementsForMode, type GoalMode } from '@/lib/domain/goals';
import { listGoals, ownedSlotsForSet } from '@/lib/services/goals';
import { SetGrid, type GridSlot } from '@/components/SetGrid';
import { TopBar } from '@/components/AppShell';
import { SourceNote } from '@/components/ui';
import { TrackButton } from '@/components/TrackButton';

export const dynamic = 'force-dynamic';

export default async function SetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ mode?: string; filter?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  const set = getSet(db, id);
  if (!set) notFound();

  const mode: GoalMode = (['main', 'complete', 'master'] as const).includes(sp.mode as GoalMode)
    ? (sp.mode as GoalMode)
    : 'main';

  const all = setRequirements(db, id);
  const primaries = primaryVariantMap(db, id);
  const required = requirementsForMode(all, mode, primaries);
  const owned = ownedIndex(ownedSlotsForSet(db, user.id, id));
  const metrics = computeGoal(mode, required, owned);

  const slots: GridSlot[] = required.map((r) => ({
    cardId: r.cardId,
    variant: r.variant,
    number: r.number,
    numberSort: r.numberSort,
    name: r.name,
    rarity: r.rarity,
    imageSmall: r.imageSmall,
    isSecret: r.isSecret,
    marketCents: r.marketCents,
    acquisitionCents: r.acquisitionCents,
    basis: r.basis,
    observedOn: r.observedOn,
    variantSource: r.variantSource,
    owned: (owned.get(`${r.cardId}::${r.variant}`) ?? 0) > 0,
    quantity: owned.get(`${r.cardId}::${r.variant}`) ?? 0,
  }));

  const goals = listGoals(db, user.id);
  const tracked = goals.find((g) => g.set_id === id && g.mode === mode);
  const inferredShare = 1 - metrics.variantConfidence;

  return (
    <>
      <TopBar
        title={set.name}
        subtitle={`${set.series} · ${set.release_date ?? 'unknown date'} · ${set.printed_total} printed`}
        back="/app/sets"
        right={<TrackButton setId={id} mode={mode} tracked={!!tracked} goalId={tracked?.id} />}
      />

      <main className="px-4 pb-8 pt-4">
        <nav aria-label="Goal type" className="mb-4 flex gap-1.5">
          {GOAL_MODES.map((m) => (
            <Link
              key={m.id}
              href={`/app/sets/${id}?mode=${m.id}`}
              aria-current={m.id === mode ? 'true' : undefined}
              className={`flex-1 rounded-xl px-3 py-2 text-center text-xs font-semibold transition ${
                m.id === mode ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
              }`}
            >
              {m.label}
            </Link>
          ))}
        </nav>
        <p className="mb-4 text-[11px] leading-relaxed text-ink-mute">
          {GOAL_MODES.find((m) => m.id === mode)?.blurb}
        </p>

        <SetGrid
          setId={id}
          mode={mode}
          slots={slots}
          initialFilter={sp.filter === 'missing' ? 'missing' : sp.filter === 'owned' ? 'owned' : 'all'}
        />

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Prices are TCGplayer USD figures republished by pokemontcg.io. Each card&apos;s tile shows
          the figure SetValue used; hover or long-press it to see which reading it came from and
          when it was observed.{' '}
          {metrics.unpricedMissing > 0 &&
            `${metrics.unpricedMissing} missing card${metrics.unpricedMissing === 1 ? '' : 's'} in this view carr${metrics.unpricedMissing === 1 ? 'ies' : 'y'} no current listing and add nothing to TO GO.`}{' '}
          {inferredShare > 0.005 &&
            `${(inferredShare * 100).toFixed(0)}% of the printings shown are inferred from the set's era and rarity because no price provider lists them separately.`}
        </SourceNote>

        <div className="mt-4 flex gap-2">
          <Link href={`/app/show?set=${id}&mode=${mode}`} className="btn-ghost flex-1">
            Card Show mode
          </Link>
          <Link href={`/app/binder?set=${id}&mode=${mode}`} className="btn-ghost flex-1">
            Binder view
          </Link>
        </div>
      </main>
    </>
  );
}
