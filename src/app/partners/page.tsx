import Link from 'next/link';
import { headers } from 'next/headers';
import {
  consumeRateLimit,
  demandMeta,
  demandPopulation,
  demandReport,
  RULES,
} from '@/lib/services/pg';
import { withIdentity } from '@/lib/db/pg';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import { CardArt, Disclosure, Money, Progress, SectionTitle } from '@/components/ui';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'SetValue for partners — what collectors actually need',
  description:
    'Aggregate, identity-free demand from collectors chasing specific sets: which exact printings they are missing right now.',
};

/**
 * Partner console.
 *
 * The question a shop owner asks is "which cards in my inventory do these
 * collectors actually need?" — and SetValue is one of the few places that can
 * answer it, because it knows what people are missing rather than what they
 * browsed.
 *
 * The hard constraint: this reports counts only. A partner sees that eleven
 * collectors need a specific printing; it never sees which collectors, what
 * else they own, or anything that could identify them. Demand is the product,
 * collectors are not.
 *
 * Everything on this page is a live aggregate of the want index. There are no
 * trends, no geography and no conversion figures, because SetValue does not
 * hold the data those would require — see the note at the foot of the page.
 */
export default async function PartnersPage({
  searchParams,
}: {
  searchParams: Promise<{ set?: string }>;
}) {
  const sp = await searchParams;

  // This page is public. It reads a trigger-maintained snapshot rather than
  // recomputing, but a per-address cap keeps anonymous traffic from turning any
  // future regression here into an outage for signed-in collectors. The counter
  // lives in Postgres, so the limit holds across every serverless instance.
  const h = await headers();
  const addr = (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
  const gate = await consumeRateLimit(
    `partners:${addr}`,
    RULES.publicPage.limit,
    RULES.publicPage.windowSeconds,
  );
  if (!gate.allowed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
        <p className="text-lg font-bold">Slow down a moment</p>
        <p className="mt-2 text-sm text-ink-mute">
          This page is rate limited. Try again in {gate.retry_after_seconds}s.
        </p>
      </main>
    );
  }

  const [demand, meta, population, bySet] = await Promise.all([
    demandReport(60, sp.set),
    demandMeta(),
    demandPopulation(),
    // Where demand concentrates, by set. A bounded aggregate over the index.
    withIdentity(null, (tx) =>
      tx.rows<{ set_id: string; set_name: string; printings: number; wants: number; cents: number }>(
        `select c.set_id, s.name as set_name,
                count(*)::int as printings,
                sum(w.collectors)::bigint as wants,
                coalesce(sum(w.collectors * public.slot_market_cents(p.market_cents,p.mid_cents,p.low_cents)),0)::bigint as cents
         from public.want_index w
         join public.cards c on c.id = w.card_id
         join public.sets s on s.id = c.set_id
         left join public.prices p
           on p.card_id = w.card_id and p.variant = w.variant and p.provider = 'tcgplayer'
         where w.collectors > 0
         group by c.set_id, s.name
         order by wants desc
         limit 8`,
      ),
    ),
  ]);

  const openWants = meta.live?.open_wants ?? 0;
  const totalDemand = meta.live?.total_demand ?? 0;
  const demandValueCents = meta.live?.demand_value ?? 0;
  const rebuiltAt = meta.meta?.rebuilt_at ?? null;
  const ageSeconds = rebuiltAt ? Math.round((Date.now() - Date.parse(rebuiltAt)) / 1000) : null;

  // Concentration: the share of all open demand sitting in the top printings.
  // Derived from the same rows shown below, not modelled.
  const topSlice = demand.slice(0, 10).reduce((t, d) => t + d.collectors, 0);
  const concentration = totalDemand ? topSlice / totalDemand : 0;
  const biggestSet = bySet[0]?.wants ?? 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-16 lg:max-w-6xl lg:px-8">
      <header className="flex items-center justify-between py-5">
        <Link href="/" className="text-base font-black tracking-tight">
          SET<span className="text-need">VALUE</span>
        </Link>
        <span className="chip">Partner console</span>
      </header>

      <section className="pt-4">
        <h1 className="text-[2.4rem] font-black leading-[1.05] tracking-tight lg:text-[3.4rem]">
          Purchase intent,
          <br />
          before the purchase.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-mute">
          A collector on SetValue has told the product exactly which cards they are missing from a
          set they are actively finishing. That is a want list, not a browsing history — and it is
          the most useful signal in this hobby.
        </p>
      </section>

      {/* ------------------------------------------------------ hero metrics */}
      <section className="panel-raise relative mt-7 overflow-hidden">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-need/[.10] to-transparent"
        />
        <div className="relative px-5 pb-5 pt-5">
          <p className="label">Open demand at market</p>
          <p className="figure mt-1.5 text-[3rem] text-need">{money(demandValueCents)}</p>
          <p className="mt-1 text-[11px] text-ink-mute">
            what collectors would spend to close every open want right now
          </p>

          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:gap-3">
            <Cell label="Wanted printings" value={openWants.toLocaleString()} />
            <Cell label="Open wants" value={totalDemand.toLocaleString()} />
            <Cell label="Active hunts" value={population.tracked.toLocaleString()} />
            <Cell label="Collectors" value={population.collectors.toLocaleString()} />
          </div>
        </div>
      </section>

      {/* Concentration and the ranked list answer the same question from two
          angles, so a wide screen shows them together instead of one under the
          other. */}
      <div className="lg:grid lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:items-start lg:gap-10">
      {/* -------------------------------------------------- concentration */}
      {bySet.length > 0 && (
        <section className="mt-8 lg:sticky lg:top-6">
          <SectionTitle>Where demand concentrates</SectionTitle>
          <p className="mb-3 text-[12px] text-ink-mute">
            The ten most wanted printings account for{' '}
            <span className="num font-bold text-white">{(concentration * 100).toFixed(1)}%</span> of
            all open wants. By set:
          </p>
          <ul className="space-y-1.5">
            {bySet.map((s) => (
              <li key={s.set_id} className="panel flex items-center gap-3 px-3.5 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">{s.set_name}</p>
                  <Progress
                    value={biggestSet ? s.wants / biggestSet : 0}
                    tone="need"
                    height="h-1.5"
                    className="mt-1.5"
                  />
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-[13px] font-bold text-need">
                    {s.wants.toLocaleString()}
                  </p>
                  <p className="num text-[10px] text-ink-mute">
                    {s.printings} printings · <Money cents={s.cents} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------------------------------------------- most wanted */}
      <section className="mt-8">
        <SectionTitle>Most wanted right now</SectionTitle>
        {demand.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-mute">
            No open wants yet. This fills as collectors track sets.
          </p>
        ) : (
          <>
            {/* The top of the list, as cards. */}
            <ul className="rail mb-3 flex gap-2.5 overflow-x-auto pb-1">
              {demand.slice(0, 12).map((d) => (
                <li key={`art-${d.card_id}-${d.variant}`} className="w-[84px] shrink-0 lg:w-[108px]">
                  <CardArt src={d.image_small} alt={d.name} label={`#${d.number}`} />
                  <p className="num mt-1 truncate text-[10px] font-bold text-need">
                    {d.collectors} want{d.collectors === 1 ? '' : 's'}
                  </p>
                  <p className="num truncate text-[10px] text-ink-mute">{money(d.market_cents)}</p>
                </li>
              ))}
            </ul>

            <ul className="space-y-2">
              {demand.slice(0, 40).map((d) => (
                <li key={`${d.card_id}-${d.variant}`} className="panel flex items-center gap-3 p-2.5">
                  <div className="w-[44px] shrink-0">
                    <CardArt src={d.image_small} alt={d.name} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">{d.name}</p>
                    <p className="num truncate text-[10px] text-ink-mute">
                      #{d.number} · {d.set_name} · {VARIANT_LABEL[d.variant as Variant]}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="num text-[14px] font-bold text-need">{d.collectors}</p>
                    <p className="num text-[10px] text-ink-mute">{money(d.market_cents)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      </div>

      <section className="mt-10">
        <SectionTitle>How partners plug in</SectionTitle>
        <ul className="space-y-2">
          {[
            ['Card shops', 'Match an inventory list against live wants to see which of your cards collectors are actually missing.', 'demand_report() aggregate', false],
            ['Marketplaces', 'A want list is a pre-qualified basket — the cards that finish a set, priced, in one call.', 'goal_missing() per collector', false],
            ['Grading companies', 'Every holding already carries grading company and grade, and graded copies are held out of raw valuation.', 'grade fields on every holding', true],
            ['Binder & supply brands', 'The binder view knows how many pages a set fills at 4, 9 and 12 pockets, and how far along the collector is.', 'binder layout engine', true],
            ['Creators', 'A public collection page is a shareable artefact with real numbers behind it, not a screenshot.', '/c/{handle}', true],
          ].map(([who, what, hook, built]) => (
            <li key={who as string} className="panel px-4 py-3.5">
              <p className="text-[13px] font-bold">
                {who}
                {!built && <span className="chip ml-2 align-middle">not built yet</span>}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-mute">{what}</p>
              <p className="num mt-1.5 text-[10px] text-ink-mute">
                {built ? 'Built on' : 'Would build on'}: {hook}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <SectionTitle>What SetValue will not do</SectionTitle>
        <div className="panel px-4 py-4">
          <ul className="space-y-2.5 text-[13px] leading-relaxed text-ink-mute">
            <li>
              <span className="font-semibold text-white">No collector identities.</span> Demand is
              reported as counts. Partners never receive who wants what.
            </li>
            <li>
              <span className="font-semibold text-white">No paid placement in recommendations.</span>{' '}
              Next Best Move ranks by completion per dollar. A partner cannot buy a position in it.
            </li>
            <li>
              <span className="font-semibold text-white">No inventory dressed as advice.</span> A
              partner holding a card can be shown as an option beside the price; it does not change
              what SetValue tells you to do.
            </li>
          </ul>
        </div>
      </section>

      <footer className="mt-10 border-t border-ink-line pt-6">
        <Disclosure summary="What these numbers are, and what is deliberately missing">
          Every figure above is a live aggregate of the want index — distinct collectors missing an
          exact printing in a set they are actively chasing — valued at TCGplayer market prices.
          {ageSeconds !== null && (
            <>
              {' '}
              The index is maintained by database triggers as collections change, so the counts are
              current; the last full reconciliation ran{' '}
              {ageSeconds < 3600 ? `${Math.round(ageSeconds / 60)}m` : `${Math.round(ageSeconds / 3600)}h`}{' '}
              ago.
            </>
          )}{' '}
          <strong className="text-white">Not shown, because the data does not exist:</strong>{' '}
          demand trends over time (the index holds current state, not history), geography (SetValue
          does not collect collector location), and any conversion or sell-through figure (no
          purchase ever passes through SetValue). There is no partner API: no partner accounts,
          inventory tables or API keys exist in the schema, so nothing here sits behind an
          integration.
        </Disclosure>
      </footer>
    </main>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
      <p className="label">{label}</p>
      <p className="num mt-1 text-[17px] font-bold">{value}</p>
    </div>
  );
}
