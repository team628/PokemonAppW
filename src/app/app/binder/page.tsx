import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getSet } from '@/lib/repo/catalog';
import { goalViews, metricsForSet } from '@/lib/services/goals';
import { TopBar } from '@/components/AppShell';
import { Empty, SourceNote } from '@/components/ui';
import { BinderPages, type BinderSlot } from '@/components/BinderPages';
import { primaryVariantMap, setRequirements } from '@/lib/repo/catalog';
import { ownedIndex, requirementsForMode, type GoalMode } from '@/lib/domain/goals';
import { ownedSlotsForSet } from '@/lib/services/goals';

export const dynamic = 'force-dynamic';

export default async function BinderPage({
  searchParams,
}: {
  searchParams: Promise<{ set?: string; mode?: string; pocket?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  const views = goalViews(db, user.id);
  const setId = sp.set ?? views[0]?.set.id;
  if (!setId) {
    return (
      <>
        <TopBar title="Binder" back="/app" />
        <main className="px-4 pt-4">
          <Empty
            title="Binder view needs a set"
            body="Pick a set and SetValue lays it out exactly as it sits in a binder — page by page, pocket by pocket, with the holes visible."
            action={{ href: '/app/sets', label: 'Choose a set' }}
          />
        </main>
      </>
    );
  }

  const set = getSet(db, setId)!;
  const mode: GoalMode =
    (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ??
    views.find((v) => v.set.id === setId)?.goal.mode ??
    'main';

  const all = setRequirements(db, setId);
  const primaries = primaryVariantMap(db, setId);
  const required = requirementsForMode(all, mode, primaries).sort((a, b) => a.numberSort - b.numberSort);
  const owned = ownedIndex(ownedSlotsForSet(db, user.id, setId));
  const metrics = metricsForSet(db, user.id, setId, mode);

  const slots: BinderSlot[] = required.map((r) => ({
    cardId: r.cardId,
    variant: r.variant,
    number: r.number,
    name: r.name,
    imageSmall: r.imageSmall,
    marketCents: r.marketCents,
    owned: (owned.get(`${r.cardId}::${r.variant}`) ?? 0) > 0,
  }));

  return (
    <>
      <TopBar
        title={`${set.name} binder`}
        subtitle={`${metrics.ownedCount}/${metrics.requiredCount} pockets filled`}
        back={`/app/sets/${setId}?mode=${mode}`}
      />
      <main className="px-4 pb-8 pt-4">
        <BinderPages
          slots={slots}
          setName={set.name}
          initialPocket={sp.pocket === '4' ? 4 : sp.pocket === '12' ? 12 : 9}
        />

        <div className="mt-5 flex gap-2">
          <Link href={`/app/binder/pull?set=${setId}&mode=${mode}`} className="btn-ghost flex-1">
            Printable pull list
          </Link>
          <Link href={`/app/show?set=${setId}&mode=${mode}`} className="btn-ghost flex-1">
            Card Show mode
          </Link>
        </div>

        <SourceNote className="mt-5 border-t border-ink-line pt-4">
          Pages are laid out in card-number order, which is how a set binder is filled. Empty
          pockets are the cards you are missing — the same list Card Show mode hands you when you
          are standing at a table.
        </SourceNote>
      </main>
    </>
  );
}
