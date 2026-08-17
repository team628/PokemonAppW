import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { goalViews, metricsForSet } from '@/lib/services/goals';
import { activeSession, sessionSummary, startSession } from '@/lib/services/show';
import { TopBar } from '@/components/AppShell';
import { ShowMode, type PullSlot, type ShowSetOption } from '@/components/ShowMode';
import { EndHuntButton } from '@/components/EndHuntButton';
import type { GoalMode } from '@/lib/domain/goals';

export const dynamic = 'force-dynamic';

export default async function ShowPage({
  searchParams,
}: {
  searchParams: Promise<{ set?: string; mode?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  // A hunt starts the moment the mode is opened. Making someone tap "start
  // session" before they can log a card is friction at exactly the wrong time.
  const session = activeSession(db, user.id) ?? startSession(db, user.id, {});
  const summary = sessionSummary(db, user.id, session.id);

  const views = goalViews(db, user.id).filter((v) => v.metrics.missingCount > 0);
  const sets: ShowSetOption[] = views.map((v) => ({
    id: v.set.id,
    name: v.set.name,
    mode: v.goal.mode,
    missingCount: v.metrics.missingCount,
    needCents: v.metrics.needCents,
    percent: v.metrics.percent,
  }));

  const chosen = sp.set ?? sets[0]?.id ?? null;
  const mode: GoalMode =
    (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ??
    sets.find((s) => s.id === chosen)?.mode ??
    'main';

  let pullList: PullSlot[] = [];
  if (chosen) {
    const metrics = metricsForSet(db, user.id, chosen, mode);
    pullList = metrics.missing
      .sort((a, b) => a.numberSort - b.numberSort)
      .map((m) => ({
        cardId: m.cardId,
        variant: m.variant,
        number: m.number,
        name: m.name,
        rarity: m.rarity,
        imageSmall: m.imageSmall,
        marketCents: m.marketCents,
        acquisitionCents: m.acquisitionCents,
      }));
  }

  return (
    <>
      <TopBar
        title="Card Show"
        subtitle={session.name}
        right={<EndHuntButton sessionId={session.id} />}
      />
      <main className="px-4 pb-8 pt-4">
        {sets.length === 0 && (
          <div className="panel mb-4 px-4 py-4">
            <p className="text-sm font-semibold">No pull list yet</p>
            <p className="mt-1 text-xs text-ink-mute">
              Card Show mode builds its list from the sets you are chasing. Track one and every card
              you still need shows up here, sorted for digging through a box.
            </p>
            <Link href="/app/sets" className="btn-primary mt-3 inline-flex">
              Track a set
            </Link>
          </div>
        )}
        <ShowMode
          sessionId={session.id}
          sets={sets}
          initialSetId={chosen}
          pullList={pullList}
          initialSummary={{
            finds: summary.finds,
            spentCents: summary.spentCents,
            marketCents: summary.marketCents,
          }}
        />
      </main>
    </>
  );
}
