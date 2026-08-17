import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { goalMetrics } from '@/lib/services/pg';
import { GOAL_MODES, type GoalMode } from '@/lib/domain/goals';
import { SetGrid, type GridSlot } from '@/components/SetGrid';
import { TopBar } from '@/components/AppShell';
import { SourceNote } from '@/components/ui';
import { TrackButton } from '@/components/TrackButton';
import type { Variant } from '@/lib/catalog/variants';

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

  const mode: GoalMode = (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ?? 'main';

  const { set, slots, goal } = await withIdentity(user.id, async (tx) => {
    const set = await tx.one<{
      id: string; name: string; series: string; printed_total: number;
      release_date: string | null; logo_url: string | null;
    }>('select id, name, series, printed_total, release_date::text, logo_url from public.sets where id = $1', [id]);
    if (!set) return { set: null, slots: [], goal: null };

    // One round trip: every required slot with its price and owned quantity.
    const rows = await tx.rows<{
      card_id: string; variant: string; number: string; number_sort: number; name: string;
      rarity: string | null; image_small: string | null; is_secret: boolean;
      market_cents: number | null; acquisition_cents: number | null; basis: string | null;
      observed_on: string | null; variant_source: 'market_data' | 'inferred'; quantity: number;
    }>('select * from public.set_grid($1, $2)', [id, mode]);

    const goal = await tx.one<{ id: string }>(
      'select id from public.set_goals where set_id = $1 and mode = $2', [id, mode],
    );
    return { set, slots: rows, goal };
  });

  if (!set) notFound();

  const grid: GridSlot[] = slots.map((r) => ({
    cardId: r.card_id,
    variant: r.variant as Variant,
    number: r.number,
    numberSort: r.number_sort,
    name: r.name,
    rarity: r.rarity,
    imageSmall: r.image_small,
    isSecret: r.is_secret,
    marketCents: r.market_cents,
    acquisitionCents: r.acquisition_cents,
    basis: r.basis,
    observedOn: r.observed_on ? String(r.observed_on).slice(0, 10) : null,
    variantSource: r.variant_source,
    owned: r.quantity > 0,
    quantity: r.quantity,
  }));

  const metrics = await goalMetrics(user.id, id, mode);
  const inferredShare = metrics.required_count
    ? 1 - metrics.market_data_slots / metrics.required_count
    : 0;

  return (
    <>
      <TopBar
        title={set.name}
        subtitle={`${set.series} · ${set.release_date ?? 'unknown date'} · ${set.printed_total} printed`}
        back="/app/sets"
        right={<TrackButton setId={id} mode={mode} tracked={!!goal} goalId={goal?.id} />}
      />
      <main className="px-4 pb-8 pt-4">
        <nav aria-label="Goal type" className="mb-4 flex gap-1.5">
          {GOAL_MODES.map((m) => (
            <Link key={m.id} href={`/app/sets/${id}?mode=${m.id}`}
              aria-current={m.id === mode ? 'true' : undefined}
              className={`flex-1 rounded-xl px-3 py-2 text-center text-xs font-semibold transition ${
                m.id === mode ? 'bg-white text-ink' : 'border border-ink-line text-ink-mute'
              }`}>
              {m.label}
            </Link>
          ))}
        </nav>
        <p className="mb-4 text-[11px] leading-relaxed text-ink-mute">
          {GOAL_MODES.find((m) => m.id === mode)?.blurb}
        </p>

        <SetGrid setId={id} mode={mode} slots={grid}
          initialFilter={sp.filter === 'missing' ? 'missing' : sp.filter === 'owned' ? 'owned' : 'all'} />

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Prices are TCGplayer USD figures. Each tile shows the figure SetValue used; hover or
          long-press it to see which reading it came from and when it was observed.{' '}
          {metrics.unpriced_missing > 0 &&
            `${metrics.unpriced_missing} missing card${metrics.unpriced_missing === 1 ? '' : 's'} in this view carr${metrics.unpriced_missing === 1 ? 'ies' : 'y'} no current listing and add nothing to TO GO.`}{' '}
          {inferredShare > 0.005 &&
            `${(inferredShare * 100).toFixed(0)}% of the printings shown are inferred from the set's era and rarity because no price provider lists them separately.`}
        </SourceNote>

        <div className="mt-4 flex gap-2">
          <Link href={`/app/show?set=${id}&mode=${mode}`} className="btn-ghost flex-1">Card Show mode</Link>
          <Link href={`/app/binder?set=${id}&mode=${mode}`} className="btn-ghost flex-1">Binder view</Link>
        </div>
      </main>
    </>
  );
}
