import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { myGoals } from '@/lib/services/pg';
import { currentOrNewSession, sessionSummary } from '@/lib/services/pg/show';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { ShowMode, type PullSlot, type ShowSetOption } from '@/components/ShowMode';
import { EndHuntButton } from '@/components/EndHuntButton';
import type { GoalMode } from '@/lib/domain/goals';
import type { Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

export default async function ShowPage({
  searchParams,
}: { searchParams: Promise<{ set?: string; mode?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();

  // A hunt starts the moment the mode opens. Making someone tap "start session"
  // before they can log a card is friction at exactly the wrong time.
  const session = await currentOrNewSession(user.id);
  const [summary, goals] = await Promise.all([
    sessionSummary(user.id, session.id),
    myGoals(user.id),
  ]);

  const active = goals.filter((g) => g.missingCount > 0);
  const sets: ShowSetOption[] = active.map((g) => ({
    id: g.setId, name: g.setName, mode: g.mode,
    missingCount: g.missingCount, needCents: g.needCents, percent: g.percent,
  }));

  const chosen = sp.set ?? sets[0]?.id ?? null;
  const mode: GoalMode =
    (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ??
    sets.find((s) => s.id === chosen)?.mode ?? 'main';

  let pullList: PullSlot[] = [];
  if (chosen) {
    const rows = await withIdentity(user.id, (tx) =>
      tx.rows<{
        card_id: string; variant: string; number: string; name: string;
        rarity: string | null; image_small: string | null;
        market_cents: number | null; acquisition_cents: number | null;
      }>('select * from public.goal_missing($1, $2, 2000, 0)', [chosen, mode]),
    );
    pullList = rows.map((m) => ({
      cardId: m.card_id, variant: m.variant as Variant, number: m.number, name: m.name,
      rarity: m.rarity, imageSmall: m.image_small,
      marketCents: m.market_cents, acquisitionCents: m.acquisition_cents,
    }));
  }

  return (
    <>
      <TopBar title="Card Show" subtitle={session.name} right={<EndHuntButton sessionId={session.id} />} />
      <main className="px-4 pb-8 pt-4">
        {sets.length === 0 && (
          <div className="panel mb-4 px-4 py-4">
            <p className="text-sm font-semibold">No pull list yet</p>
            <p className="mt-1 text-xs text-ink-mute">
              Card Show mode builds its list from the sets you are chasing. Track one and every card
              you still need shows up here, sorted for digging through a box.
            </p>
            <Link href="/app/sets" className="btn-primary mt-3 inline-flex">Track a set</Link>
          </div>
        )}
        <ShowMode sessionId={session.id} sets={sets} initialSetId={chosen} pullList={pullList}
          initialSummary={{ finds: summary.finds, spentCents: summary.spentCents, marketCents: summary.marketCents }} />
      </main>
    </>
  );
}
