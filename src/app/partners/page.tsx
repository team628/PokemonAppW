import Link from 'next/link';
import { headers } from 'next/headers';
import { consumeRateLimit, demandMeta, demandReport, RULES } from '@/lib/services/pg';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import { CardArt } from '@/components/ui';

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
  // lives in Postgres, so the limit holds across every serverless instance
  // rather than per-process.
  const h = await headers();
  const addr = (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
  const gate = await consumeRateLimit(`partners:${addr}`, RULES.publicPage.limit, RULES.publicPage.windowSeconds);
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

  const [demand, meta] = await Promise.all([demandReport(60, sp.set), demandMeta()]);
  const collectors = meta.collectors;
  const tracked = meta.tracked;
  // Counts come from the live index; the rebuild stamp describes the last full
  // reconciliation pass, which is a different thing and is labelled as such.
  const openWants = meta.live?.open_wants ?? 0;
  const totalDemand = meta.live?.total_demand ?? 0;
  const demandValueCents = meta.live?.demand_value ?? 0;
  const rebuiltAt = meta.meta?.rebuilt_at ?? null;
  const rebuildMs = meta.meta?.duration_ms ?? null;
  const ageSeconds = rebuiltAt ? Math.round((Date.now() - Date.parse(rebuiltAt)) / 1000) : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-5 pb-16">
      <header className="flex items-center justify-between py-5">
        <Link href="/" className="text-base font-black tracking-tight">
          SET<span className="text-need">VALUE</span>
        </Link>
        <span className="chip">Partner console</span>
      </header>

      <section className="pt-6">
        <h1 className="text-3xl font-black leading-tight tracking-tight">
          Purchase intent, before the purchase.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-mute">
          A collector on SetValue has told the product exactly which cards they are missing from a
          set they are actively finishing. That is a want list, not a browsing history — and it is
          the most useful signal in this hobby.
        </p>
      </section>

      <section className="panel mt-7 grid grid-cols-2 gap-px overflow-hidden bg-ink-line sm:grid-cols-4">
        <Cell label="Collectors" value={collectors.toLocaleString()} />
        <Cell label="Sets being chased" value={tracked.toLocaleString()} />
        <Cell label="Open card wants" value={totalDemand.toLocaleString()} />
        <Cell label="Want value" value={money(demandValueCents)} />
      </section>

      <section className="mt-10">
        <h2 className="label">Live demand — what collectors are missing right now</h2>
        <p className="mt-1.5 text-[11px] text-ink-mute">
          {openWants.toLocaleString()} distinct printings have at least one collector waiting; the{' '}
          {demand.length} most wanted are shown. These counts are current: the index is maintained
          by database triggers as collections and goals change, so there is no stale window.
          {ageSeconds === null ? (
            <> A full reconciliation rebuild has not run yet on this instance.</>
          ) : (
            <>
              {' '}Last full reconciliation{' '}
              {ageSeconds < 60 ? `${ageSeconds}s` : ageSeconds < 5400 ? `${Math.round(ageSeconds / 60)}m` : `${Math.round(ageSeconds / 3600)}h`}{' '}
              ago
              {rebuildMs !== null && ` (took ${(rebuildMs / 1000).toFixed(1)}s)`}.
            </>
          )}
        </p>
        {demand.length === 0 ? (
          <p className="panel mt-3 px-4 py-8 text-center text-sm text-ink-mute">
            No open wants yet. This table fills as collectors track sets.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {demand.map((d) => (
              <li key={`${d.card_id}-${d.variant}`} className="panel flex items-center gap-3 p-2.5">
                <div className="w-[44px] shrink-0">
                  <CardArt src={d.image_small} alt={d.name} label={`#${d.number}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{d.name}</p>
                  <p className="num truncate text-[11px] text-ink-mute">
                    #{d.number} · {d.set_name} · {VARIANT_LABEL[d.variant as Variant]}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm font-bold text-need">
                    {d.collectors} want{d.collectors === 1 ? 's' : ''}
                  </p>
                  <p className="num text-[11px] text-ink-mute">{money(d.market_cents)} market</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12">
        <h2 className="label">How partners plug in</h2>
        <ul className="mt-3 space-y-2">
          {[
            ['Card shops', 'Match an inventory list against live wants to see which of your cards collectors are actually missing.', 'demand_report() aggregate', false],
            ['Marketplaces', 'A want list is a pre-qualified basket — the cards that finish a set, priced, in one call.', 'goal_missing() per collector', false],
            ['Grading companies', 'Collectors decide what to submit here. Every holding already carries grading company and grade, and graded copies are held out of raw valuation.', 'grade fields on every holding', true],
            ['Binder & supply brands', 'The binder view knows how many pages a set fills at 4, 9 and 12 pockets, and how far along the collector is.', 'binder layout engine', true],
            ['Creators', 'A public collection page is a shareable artefact with real numbers behind it, not a screenshot.', '/c/{handle}', true],
          ].map(([who, what, hook, built]) => (
            <li key={who as string} className="panel px-4 py-3.5">
              <p className="text-sm font-bold">
                {who}
                {!built && <span className="chip ml-2 align-middle">not built yet</span>}
              </p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">{what}</p>
              <p className="num mt-1.5 text-[11px] text-ink-mute">
                {built ? 'Built on' : 'Would build on'}: {hook}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="label">What SetValue will not do</h2>
        <div className="panel mt-3 px-4 py-4">
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
              <span className="font-semibold text-white">No inventory dressed as advice.</span> If a
              partner has a card, it can be shown as an option next to the price — it does not
              change what SetValue tells you to do.
            </li>
          </ul>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-mute">
          The trade is simple: partners get a demand signal nobody else has, collectors get an app
          that never lies to them about what to buy. Break the second and the first stops being
          worth anything.
        </p>
      </section>

      <footer className="mt-12 border-t border-ink-line pt-6 text-xs text-ink-mute">
        <p>
          The demand table above is computed from this instance&apos;s collectors, through the same
          <span className="num"> demand_report() </span> function the product uses. There is no
          partner API: no partner accounts, inventory tables or API keys exist in the schema yet, so
          nothing on this page is behind an integration. It is the signal, shown as it stands.
        </p>
      </footer>
    </main>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-soft px-4 py-3">
      <p className="label">{label}</p>
      <p className="num mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
