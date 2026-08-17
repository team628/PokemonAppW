import Link from 'next/link';
import { getDb } from '@/lib/db';
import { demandReport, type DemandRow } from '@/lib/services/demand';
import { ensureWantIndexFresh } from '@/lib/services/wantIndexScheduler';
import { headers } from 'next/headers';
import { RULES, checkLimit } from '@/lib/rateLimit';
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
  const db = getDb();

  // This page is public. It now reads a materialised snapshot rather than
  // recomputing, but a per-address cap keeps anonymous traffic from turning any
  // future regression here into an outage for signed-in collectors.
  const h = await headers();
  const addr = (h.get('x-forwarded-for')?.split(',')[0] ?? h.get('x-real-ip') ?? 'unknown').trim();
  const gate = checkLimit(db, `partners:${addr}`, RULES.publicPage);
  if (!gate.allowed) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
        <p className="text-lg font-bold">Slow down a moment</p>
        <p className="mt-2 text-sm text-ink-mute">
          This page is rate limited. Try again in {gate.retryAfterSeconds}s.
        </p>
      </main>
    );
  }

  // Non-blocking: kicks a worker-thread rebuild if the index has gone stale and
  // returns whatever snapshot exists. No request ever waits for the aggregate.
  ensureWantIndexFresh();

  const report = demandReport(db, { limit: 60, setId: sp.set });
  const demand: DemandRow[] = report.rows;
  const collectors = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const tracked = (db.prepare('SELECT COUNT(*) AS n FROM set_goals').get() as { n: number }).n;
  const ageSeconds = report.computedAt
    ? Math.round((Date.now() - Date.parse(report.computedAt)) / 1000)
    : null;

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
        <Cell label="Open card wants" value={report.totalDemand.toLocaleString()} />
        <Cell label="Want value" value={money(report.demandValueCents)} />
      </section>

      <section className="mt-10">
        <h2 className="label">Live demand — what collectors are missing right now</h2>
        <p className="mt-1.5 text-[11px] text-ink-mute">
          {ageSeconds === null ? (
            <>The demand index has not been built yet. It is being computed now; reload shortly.</>
          ) : (
            <>
              {report.openWants.toLocaleString()} distinct printings have at least one collector
              waiting; the {demand.length} most wanted are shown. Snapshot taken{' '}
              {ageSeconds < 60 ? `${ageSeconds}s` : `${Math.round(ageSeconds / 60)}m`} ago
              {report.durationMs !== null && ` (rebuild took ${(report.durationMs / 1000).toFixed(1)}s)`}.
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
              <li key={`${d.cardId}-${d.variant}`} className="panel flex items-center gap-3 p-2.5">
                <div className="w-[44px] shrink-0">
                  <CardArt src={d.imageSmall} alt={d.name} label={`#${d.number}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{d.name}</p>
                  <p className="num truncate text-[11px] text-ink-mute">
                    #{d.number} · {d.setName} · {VARIANT_LABEL[d.variant as Variant]}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num text-sm font-bold text-need">
                    {d.collectors} want{d.collectors === 1 ? 's' : ''}
                  </p>
                  <p className="num text-[11px] text-ink-mute">{money(d.marketCents)} market</p>
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
            ['Card shops', 'Upload inventory; SetValue matches it against live wants and tells you which of your cards collectors near you are missing.', 'partner_inventory + demand match'],
            ['Marketplaces', 'A want list is a pre-qualified basket. SetValue can hand a collector a cart of exactly the cards that finish their set.', 'missing-card export'],
            ['Grading companies', 'Collectors decide what to submit here — the app already knows which of their cards are high-value and which are duplicates.', 'grade fields on every holding'],
            ['Binder & supply brands', 'The binder view knows how many pages a set fills at 4, 9 and 12 pockets, and how far along the collector is.', 'binder layout engine'],
            ['Creators', 'A public collection page is a shareable artefact with real numbers behind it, not a screenshot.', '/c/{handle}'],
          ].map(([who, what, hook]) => (
            <li key={who} className="panel px-4 py-3.5">
              <p className="text-sm font-bold">{who}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-mute">{what}</p>
              <p className="num mt-1.5 text-[11px] text-ink-mute">Built on: {hook}</p>
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
          The demand table above is computed live from this instance&apos;s collectors. A production
          integration would be a scoped, authenticated API over the same
          <span className="num"> demandReport </span> query — partner records and inventory tables
          already exist in the schema, but no partner API keys are issued in this environment.
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
