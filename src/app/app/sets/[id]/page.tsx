import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { goalMetrics } from '@/lib/services/pg';
import { GOAL_MODES, type GoalMode } from '@/lib/domain/goals';
import { SetGrid, type GridSlot } from '@/components/SetGrid';
import { TopBar } from '@/components/AppShell';
import { Disclosure, Money, Ring } from '@/components/ui';
import { TrackButton } from '@/components/TrackButton';
import { money } from '@/lib/pricing/quote';
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

  const mode: GoalMode =
    (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ?? 'main';

  const { set, slots, goal, displayName } = await withIdentity(user.id, async (tx) => {
    const set = await tx.one<{
      id: string; name: string; series: string; printed_total: number;
      release_date: string | null; logo_url: string | null; symbol_url: string | null;
    }>(
      `select id, name, series, printed_total, release_date::text, logo_url, symbol_url
       from public.sets where id = $1`,
      [id],
    );
    if (!set) return { set: null, slots: [], goal: null, displayName: null };

    // One round trip: every required slot with its price and owned quantity.
    const rows = await tx.rows<{
      card_id: string; variant: string; number: string; number_sort: number; name: string;
      rarity: string | null; image_small: string | null; is_secret: boolean;
      market_cents: number | null; acquisition_cents: number | null; basis: string | null;
      observed_on: string | null; variant_source: 'market_data' | 'inferred'; quantity: number;
    }>('select * from public.set_grid($1, $2)', [id, mode]);

    const goal = await tx.one<{ id: string }>(
      'select id from public.set_goals where set_id = $1 and mode = $2',
      [id, mode],
    );
    // Only so a completion card can name who finished the set.
    const me = await tx.one<{ display_name: string }>(
      'select display_name from public.profiles where id = $1::uuid',
      [user.id],
    );
    return { set, slots: rows, goal, displayName: me?.display_name ?? null };
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
  const pct = metrics.required_count ? metrics.owned_count / metrics.required_count : 0;
  const done = metrics.missing_count === 0 && metrics.required_count > 0;

  // Spares of this set, from the rows already loaded — no extra query.
  const spares = grid.filter((s) => s.quantity > 1);
  const spareCopies = spares.reduce((t, s) => t + (s.quantity - 1), 0);
  const spareValue = spares.reduce((t, s) => t + (s.marketCents ?? 0) * (s.quantity - 1), 0);

  return (
    <>
      <TopBar
        title={set.name}
        subtitle={`${set.series}${set.release_date ? ` · ${set.release_date.slice(0, 4)}` : ''}`}
        back="/app/sets"
        right={<TrackButton setId={id} mode={mode} tracked={!!goal} goalId={goal?.id} />}
      />

      {/* From `lg` the command deck stops scrolling away: the figures a
          collector is working against stay pinned beside the grid instead of
          disappearing off the top the way they have to on a phone. */}
      <main className="px-4 pb-8 pt-4 lg:grid lg:grid-cols-[352px_minmax(0,1fr)] lg:items-start lg:gap-8">
        <div className="lg:sticky lg:top-[72px] lg:space-y-3">
        {/* ---------------------------------------------------- command deck */}
        <section className="panel-raise relative overflow-hidden">
          {set.logo_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={set.logo_url}
              alt=""
              aria-hidden
              className="pointer-events-none absolute -right-6 -top-4 h-28 opacity-[0.07]"
            />
          )}
          <div
            aria-hidden
            className={`pointer-events-none absolute inset-x-0 top-0 h-36 ${
              done ? 'bg-gradient-to-b from-have/[.10]' : 'bg-gradient-to-b from-need/[.10]'
            } to-transparent`}
          />

          <div className="relative px-5 pb-5 pt-4">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                {done ? (
                  <>
                    <p className="figure text-[2.9rem] text-have">$0</p>
                    <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-have">
                      Set complete
                    </p>
                  </>
                ) : (
                  <>
                    <p className="figure text-[2.9rem] text-need">{money(metrics.need_cents)}</p>
                    <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[.18em] text-need/80">
                      {metrics.unpriced_missing > 0 ? 'Left to complete · at least' : 'Left to complete'}
                    </p>
                  </>
                )}
              </div>
              <Ring value={pct} size={72} stroke={6} tone={done ? 'have' : 'need'}>
                <span className="num text-[16px] font-extrabold leading-none">
                  {(pct * 100).toFixed(0)}%
                </span>
                <span className="mt-0.5 text-[9px] font-semibold uppercase tracking-wider text-ink-mute">
                  done
                </span>
              </Ring>
            </div>

            <p className="num mt-3 text-[11px] text-ink-mute">
              <span className="font-semibold text-white">{(pct * 100).toFixed(1)}% complete</span>
              {' · '}
              {metrics.owned_count}/{metrics.required_count} cards
              {!done && <> · {metrics.missing_count} remaining</>}
            </p>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                <p className="label">Have</p>
                <Money cents={metrics.have_cents} className="mt-1 block text-[17px] font-bold text-have" />
              </div>
              <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                <p className="label">Complete</p>
                <Money cents={metrics.complete_cents} className="mt-1 block text-[17px] font-bold" />
              </div>
            </div>

            {/* Base / Complete / Master */}
            <nav aria-label="Goal type" className="mt-4 flex gap-1.5" role="tablist">
              {GOAL_MODES.map((m) => (
                <Link
                  key={m.id}
                  href={`/app/sets/${id}?mode=${m.id}`}
                  role="tab"
                  aria-selected={m.id === mode}
                  aria-current={m.id === mode ? 'true' : undefined}
                  title={m.blurb}
                  className={`flex-1 rounded-xl px-3 py-2 text-center text-xs font-semibold transition ${
                    m.id === mode
                      ? 'bg-white text-ink'
                      : 'border border-ink-line text-ink-mute hover:border-ink-edge'
                  }`}
                >
                  {m.label.replace(' Set', '')}
                </Link>
              ))}
            </nav>

            <div className="mt-3 flex gap-2">
              {!done && (
                <Link href={`/app/show?set=${id}&mode=${mode}`} className="btn-need flex-1">
                  Card Show
                </Link>
              )}
              <Link
                href={`/app/binder?set=${id}&mode=${mode}`}
                className={done ? 'btn-primary flex-1' : 'btn-ghost flex-1'}
              >
                Binder
              </Link>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------ finish or flip */}
        {spareCopies > 0 && (
          <section className="panel mt-3 px-4 py-3.5">
            <p className="label">Finish or flip</p>
            <div className="mt-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <Money cents={metrics.need_cents} className="block text-[15px] font-bold text-need" />
                <p className="text-[11px] text-ink-mute">to finish this set</p>
              </div>
              <span aria-hidden className="text-ink-dim">vs</span>
              <div className="min-w-0 flex-1 text-right">
                <Money cents={spareValue} className="block text-[15px] font-bold text-have" />
                <p className="text-[11px] text-ink-mute">
                  {spareCopies} spare cop{spareCopies === 1 ? 'y' : 'ies'} you hold
                </p>
              </div>
            </div>
            <Link href="/app/trade" className="btn-ghost mt-3 w-full">
              Match spares against other collectors
            </Link>
          </section>
        )}

        </div>

        <div className="min-w-0">
        <SetGrid
          setId={id}
          mode={mode}
          slots={grid}
          identity={{
            setId: set.id,
            setName: set.name,
            series: set.series,
            logoUrl: set.logo_url,
            mode,
            collector: displayName,
          }}
          initialFilter={sp.filter === 'missing' ? 'missing' : sp.filter === 'owned' ? 'owned' : 'all'}
        />

        <div className="mt-5 border-t border-ink-line pt-4">
          <Disclosure summary="Where these prices come from">
            TCGplayer market figures in USD. Each tile shows the figure SetValue used; long-press a
            price to see which reading it came from and when it was observed.{' '}
            {metrics.unpriced_missing > 0 && (
              <>
                {metrics.unpriced_missing} missing card
                {metrics.unpriced_missing === 1 ? '' : 's'} here carr
                {metrics.unpriced_missing === 1 ? 'ies' : 'y'} no current listing and add nothing to
                the total, which is why it is a floor.{' '}
              </>
            )}
            {inferredShare > 0.005 && (
              <>
                {(inferredShare * 100).toFixed(0)}% of the printings shown are inferred from the
                set&apos;s era and rarity because no price provider lists them separately.
              </>
            )}
          </Disclosure>
        </div>
        </div>
      </main>
    </>
  );
}
