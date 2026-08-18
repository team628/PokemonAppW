import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { Disclosure, Money, SectionTitle } from '@/components/ui';
import { portfolioSummary } from '@/lib/services/pg/collection';
import { myProfile } from '@/lib/services/pg/profile';
import { signOutAction } from '@/app/actions/auth';
import { ShareToggle } from '@/components/ShareToggle';
import { MILESTONE_COPY, type MilestoneKind } from '@/lib/domain/goals';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const user = await requireUser();
  const [profile, summary] = await Promise.all([myProfile(user.id), portfolioSummary(user.id)]);
  if (!profile) notFound();

  const { runs, coverage, freshness, badges, finished } = await withIdentity(user.id, async (tx) => {
    const badges = await tx.rows<{ kind: string; set_name: string; achieved_at: string }>(
      `select m.kind, s.name as set_name, m.achieved_at::text
       from public.milestones m
       join public.set_goals g on g.id = m.goal_id
       join public.sets s on s.id = g.set_id
       where m.user_id = $1::uuid
       order by m.achieved_at desc limit 12`,
      [user.id],
    );
    const finished = (await tx.one<{ n: number }>(
      `select count(*)::int as n from public.set_goals
       where user_id = $1::uuid and completed_at is not null`,
      [user.id],
    ))!.n;

    const runs = await tx.rows<{
      kind: string; source: string; finished_at: string | null; rows_written: number; status: string;
    }>(
      `select kind::text, source, finished_at::text, rows_written, status::text
       from public.sync_runs order by id desc limit 4`,
    );

    const coverage = (await tx.one<{
      cards: number; sets: number; slots: number; priced: number;
      inferred: number; newest: string | null; snapshots: number;
    }>(
      `select
         (select count(*) from public.cards)::int as cards,
         (select count(*) from public.sets)::int as sets,
         (select count(*) from public.card_variants)::int as slots,
         (select count(*) from public.card_variants v
            join public.prices p
              on p.card_id = v.card_id and p.variant = v.variant and p.provider = 'tcgplayer')::int as priced,
         (select count(*) from public.card_variants where source = 'inferred')::int as inferred,
         (select max(observed_on)::text from public.prices where provider = 'tcgplayer') as newest,
         (select count(distinct observed_on) from public.price_points)::int as snapshots`,
    ))!;

    const freshness = await tx.rows<{
      kind: string; last_success: string | null; last_status: string; age_seconds: number;
    }>(
      'select kind::text, last_success::text, last_status::text, age_seconds from public.data_freshness()',
    );

    return { runs, coverage, freshness, badges, finished };
  });

  const displayName = profile.display_name;

  return (
    <>
      <TopBar title="Profile" back="/app" />
      <main className="space-y-7 px-4 pb-8 pt-4">
        {/* ------------------------------------------------------- identity */}
        <section className="panel-raise relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-have/[.10] to-transparent"
          />
          <div className="relative px-5 pb-4 pt-5">
            <div className="flex items-center gap-4">
              <span
                className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-black text-ink"
                style={{ background: profile.avatar_color }}
              >
                {displayName.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xl font-extrabold leading-tight">{displayName}</p>
                <p className="truncate text-[11px] text-ink-mute">@{profile.handle}</p>
                <p className="mt-0.5 text-[10px] text-ink-dim">
                  Collecting since{' '}
                  {new Date(profile.created_at).toLocaleDateString('en-US', {
                    month: 'short',
                    year: 'numeric',
                  })}
                </p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                <p className="label">Value</p>
                <Money
                  cents={summary.estimatedValueCents}
                  className="mt-1 block text-[15px] font-bold text-have"
                />
              </div>
              <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                <p className="label">Cards</p>
                <p className="num mt-1 text-[15px] font-bold">
                  {summary.totalCards.toLocaleString()}
                </p>
              </div>
              <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                <p className="label">Sets done</p>
                <p className="num mt-1 text-[15px] font-bold text-gold">{finished}</p>
              </div>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ highlights */}
        {badges.length > 0 && (
          <section>
            <SectionTitle
              action={
                <Link
                  href="/app/journey"
                  className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
                >
                  Full journey
                </Link>
              }
            >
              Highlights
            </SectionTitle>
            <ul className="flex flex-wrap gap-1.5">
              {badges.map((b, i) => {
                const copy = MILESTONE_COPY[b.kind as MilestoneKind];
                const gold = b.kind === 'complete';
                return (
                  <li key={`${b.kind}-${i}`}>
                    <span
                      className={`chip ${gold ? 'border-gold/40 text-gold' : 'border-have/30 text-have'}`}
                      title={`${b.set_name} · ${new Date(b.achieved_at).toLocaleDateString()}`}
                    >
                      {copy?.title ?? b.kind} · {b.set_name}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* ---------------------------------------------------- public page */}
        <section>
          <SectionTitle>Public showcase</SectionTitle>
          <ShareToggle handle={profile.handle} initial={profile.share_public} />
        </section>

        <section>
          <SectionTitle>Elsewhere</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/app/journey" className="btn-ghost">
              Journey
            </Link>
            <Link href="/partners" className="btn-ghost">
              Partner console
            </Link>
          </div>
        </section>

        {/* --------------------------------------------------- data section */}
        <section>
          <SectionTitle>Data &amp; pricing</SectionTitle>
          <div className="panel divide-y divide-ink-line">
            <Row label="Catalog" value={`${coverage.sets} sets · ${coverage.cards.toLocaleString()} cards`} />
            <Row
              label="Price coverage"
              value={`${((coverage.priced / Math.max(1, coverage.slots)) * 100).toFixed(1)}%`}
            />
            <Row label="Newest reading" value={coverage.newest ?? '—'} />
            {freshness.map((f) => (
              <Row
                key={f.kind}
                label={JOB_LABEL[f.kind] ?? f.kind}
                value={f.last_success ? `${describeAge(f.age_seconds)} ago · ${f.last_status}` : 'never run'}
              />
            ))}
          </div>

          <Disclosure summary="Where these numbers come from" className="mt-2.5">
            Catalog from the PokemonTCG open dataset. Prices from TCGplayer and Cardmarket via
            pokemontcg.io, each carrying its own observation date.{' '}
            {coverage.inferred.toLocaleString()} printings (
            {((coverage.inferred / Math.max(1, coverage.slots)) * 100).toFixed(1)}%) are inferred
            from a set&apos;s era and rarity because no provider lists them separately — those are
            labelled wherever they appear. SetValue holds {coverage.snapshots} dated snapshot
            {coverage.snapshots === 1 ? '' : 's'}
            {coverage.snapshots < 2 &&
              ', which is why price-change features stay switched off rather than guessing at a trend'}
            .
            {runs.length > 0 && (
              <>
                {' '}
                Last runs:{' '}
                {runs
                  .map(
                    (r) =>
                      `${r.kind} ${r.status} (${r.rows_written.toLocaleString()} rows, ${
                        r.finished_at?.slice(0, 16).replace('T', ' ') ?? 'running'
                      })`,
                  )
                  .join('; ')}
                .
              </>
            )}
          </Disclosure>
        </section>

        <div className="pt-1">
          <p className="mb-2 text-[11px] text-ink-mute">
            Signed in{user.email ? ` as ${user.email}` : ''}
          </p>
          <form action={signOutAction}>
            <button className="btn-ghost w-full text-need">Sign out</button>
          </form>
        </div>
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
      <span className="text-[11px] text-ink-mute">{label}</span>
      <span className="num text-[11px] font-semibold">{value}</span>
    </div>
  );
}
