import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { TopBar } from '@/components/AppShell';
import { SectionTitle, SourceNote } from '@/components/ui';
import { portfolioSummary } from '@/lib/services/collection';
import { signOutAction } from '@/app/actions/auth';
import { ShareToggle } from '@/components/ShareToggle';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const user = await requireUser();
  const db = getDb();
  const summary = portfolioSummary(db, user.id);

  const runs = db
    .prepare('SELECT kind, source, finished_at, rows, notes FROM ingest_runs ORDER BY id DESC LIMIT 4')
    .all() as { kind: string; source: string; finished_at: string | null; rows: number; notes: string | null }[];

  const coverage = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM cards) AS cards,
         (SELECT COUNT(*) FROM sets) AS sets,
         (SELECT COUNT(*) FROM card_variants) AS slots,
         (SELECT COUNT(*) FROM card_variants v
            JOIN prices p ON p.card_id = v.card_id AND p.variant = v.variant AND p.provider='tcgplayer') AS priced,
         (SELECT COUNT(*) FROM card_variants WHERE source='inferred') AS inferred,
         (SELECT MAX(observed_on) FROM prices WHERE provider='tcgplayer') AS newest,
         (SELECT MIN(observed_on) FROM prices WHERE provider='tcgplayer') AS oldest,
         (SELECT COUNT(DISTINCT observed_on) FROM price_points) AS snapshots`,
    )
    .get() as {
    cards: number; sets: number; slots: number; priced: number; inferred: number;
    newest: string | null; oldest: string | null; snapshots: number;
  };

  return (
    <>
      <TopBar title="Profile" back="/app" />
      <main className="space-y-6 px-4 pb-8 pt-4">
        <section className="panel flex items-center gap-4 px-4 py-4">
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full text-xl font-black text-ink"
            style={{ background: user.avatar_color }}
          >
            {user.display_name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold">{user.display_name}</p>
            <p className="truncate text-xs text-ink-mute">@{user.handle} · {user.email}</p>
            <p className="num mt-1 text-xs text-have">
              {summary.totalCards.toLocaleString()} cards · {money(summary.valueCents)}
            </p>
          </div>
        </section>

        <section>
          <SectionTitle>Share</SectionTitle>
          <ShareToggle handle={user.handle} initial={user.share_public === 1} />
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
          {runs.length > 0 && (
            <ul className="mt-3 space-y-1">
              {runs.map((r, i) => (
                <li key={i} className="num text-[11px] text-ink-mute">
                  {r.kind} · {r.rows.toLocaleString()} rows · {r.finished_at?.slice(0, 16).replace('T', ' ')} · {r.source}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-ink-mute">{label}</span>
      <span className="num text-xs font-semibold">{value}</span>
    </div>
  );
}
