import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { SectionTitle, SourceNote } from '@/components/ui';
import { portfolioSummary } from '@/lib/services/pg/collection';
import { myProfile } from '@/lib/services/pg/profile';
import { signOutAction } from '@/app/actions/auth';
import { ShareToggle } from '@/components/ShareToggle';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

interface Coverage {
  cards: number;
  sets: number;
  slots: number;
  priced: number;
  inferred: number;
  newest: string | null;
  oldest: string | null;
  snapshots: number;
}

interface RunRow {
  kind: string;
  source: string;
  finished_at: string | null;
  rows_written: number;
  status: string;
}

export default async function ProfilePage() {
  const user = await requireUser();
  const [profile, summary] = await Promise.all([myProfile(user.id), portfolioSummary(user.id)]);
  if (!profile) notFound();

  const { runs, coverage, freshness } = await withIdentity(user.id, async (tx) => {
    const runs = await tx.rows<RunRow>(
      `select kind::text, source, finished_at::text, rows_written, status::text
       from public.sync_runs
       order by id desc
       limit 4`,
    );

    const coverage = (await tx.one<Coverage>(
      `select
         (select count(*) from public.cards)::int as cards,
         (select count(*) from public.sets)::int as sets,
         (select count(*) from public.card_variants)::int as slots,
         (select count(*) from public.card_variants v
            join public.prices p
              on p.card_id = v.card_id and p.variant = v.variant and p.provider = 'tcgplayer')::int as priced,
         (select count(*) from public.card_variants where source = 'inferred')::int as inferred,
         (select max(observed_on)::text from public.prices where provider = 'tcgplayer') as newest,
         (select min(observed_on)::text from public.prices where provider = 'tcgplayer') as oldest,
         (select count(distinct observed_on) from public.price_points)::int as snapshots`,
    ))!;

    // The scheduled jobs report their own last success rather than the app
    // guessing from row timestamps — an hourly price run and a nightly catalog
    // run are separate pipelines and are reported separately.
    const freshness = await tx.rows<{
      kind: string; last_success: string | null; last_status: string; age_seconds: number;
    }>('select kind::text, last_success::text, last_status::text, age_seconds from public.data_freshness()');

    return { runs, coverage, freshness };
  });

  const displayName = profile.display_name;

  return (
    <>
      <TopBar title="Profile" back="/app" />
      <main className="space-y-6 px-4 pb-8 pt-4">
        <section className="panel flex items-center gap-4 px-4 py-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-black text-ink"
            style={{ background: profile.avatar_color }}
          >
            {displayName.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{displayName}</p>
            <p className="truncate text-xs text-ink-mute">
              @{profile.handle}
              {user.email && ` · ${user.email}`}
            </p>
            <p className="num mt-1 text-xs text-have">
              {summary.totalCards.toLocaleString()} cards · {money(summary.estimatedValueCents)}
            </p>
          </div>
        </section>

        <section>
          <SectionTitle>Share</SectionTitle>
          <ShareToggle handle={profile.handle} initial={profile.share_public} />
        </section>

        <section>
          <SectionTitle>Where the numbers come from</SectionTitle>
          <div className="panel divide-y divide-ink-line">
            <Row label="Catalog" value={`${coverage.sets} sets · ${coverage.cards.toLocaleString()} cards`} />
            <Row
              label="Price coverage"
              value={`${((coverage.priced / Math.max(1, coverage.slots)) * 100).toFixed(1)}% of ${coverage.slots.toLocaleString()} printings`}
            />
            <Row
              label="Printings inferred"
              value={`${coverage.inferred.toLocaleString()} (${((coverage.inferred / Math.max(1, coverage.slots)) * 100).toFixed(1)}%)`}
            />
            <Row label="Newest price reading" value={coverage.newest ?? '—'} />
            <Row label="Dated snapshots held" value={String(coverage.snapshots)} />
          </div>
          <SourceNote className="mt-2">
            Catalog from the PokemonTCG/pokemon-tcg-data project. Prices from TCGplayer and
            Cardmarket via pokemontcg.io. Inferred printings are cards no price provider lists
            separately, where SetValue derives the printing from the set&apos;s era and the
            card&apos;s rarity — those are labelled everywhere they appear.
            {coverage.snapshots < 2 &&
              ' With a single dated snapshot held, price-change features stay switched off rather than guessing at a trend.'}
          </SourceNote>

          {freshness.length > 0 && (
            <div className="panel mt-3 divide-y divide-ink-line">
              {freshness.map((f) => (
                <Row
                  key={f.kind}
                  label={JOB_LABEL[f.kind] ?? f.kind}
                  value={
                    f.last_success
                      ? `${describeAge(f.age_seconds)} ago · ${f.last_status}`
                      : 'never run'
                  }
                />
              ))}
            </div>
          )}

          {runs.length > 0 && (
            <ul className="mt-3 space-y-1">
              {runs.map((r, i) => (
                <li key={i} className="num text-[11px] text-ink-mute">
                  {r.kind} · {r.rows_written.toLocaleString()} rows ·{' '}
                  {r.finished_at?.slice(0, 16).replace('T', ' ') ?? 'running'} · {r.source} · {r.status}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionTitle>Elsewhere</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/app/journey" className="btn-ghost">Journey</Link>
            <Link href="/partners" className="btn-ghost">Partner console</Link>
          </div>
        </section>

        <form action={signOutAction}>
          <button className="btn-ghost w-full text-need">Sign out</button>
        </form>
      </main>
    </>
  );
}

const JOB_LABEL: Record<string, string> = {
  hourly_prices: 'Hourly price sync',
  nightly_catalog: 'Nightly catalog sync',
  want_index: 'Want index rebuild',
  manual: 'Manual run',
};

function describeAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-ink-mute">{label}</span>
      <span className="num text-xs font-semibold">{value}</span>
    </div>
  );
}
