import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listSets } from '@/lib/repo/catalog';
import { listGoals } from '@/lib/services/goals';
import { TopBar } from '@/components/AppShell';
import { SetBrowser, type SetCard } from '@/components/SetBrowser';

export const dynamic = 'force-dynamic';

export default async function SetsPage() {
  const user = await requireUser();
  const db = getDb();

  const sets = listSets(db);
  const goals = listGoals(db, user.id);
  const trackedModes = new Map(goals.map((g) => [`${g.set_id}`, g.mode]));

  // Two aggregate queries cover the whole browser: what each main set is worth,
  // and how many of each set's cards this collector already holds. Computing
  // full completion metrics for 174 sets on a list screen would be wasteful —
  // the exact figures live on the set page.
  const values = db
    .prepare(
      `SELECT c.set_id AS set_id,
              SUM(COALESCE(p.market_cents, p.mid_cents, p.low_cents, 0)) AS cents,
              COUNT(*) AS slots
       FROM cards c
       JOIN card_variants v ON v.card_id = c.id AND v.is_primary = 1
       LEFT JOIN prices p ON p.card_id = c.id AND p.variant = v.variant AND p.provider='tcgplayer'
       WHERE c.is_secret = 0
       GROUP BY c.set_id`,
    )
    .all() as { set_id: string; cents: number; slots: number }[];
  const valueBySet = new Map(values.map((v) => [v.set_id, v]));

  const ownedRows = db
    .prepare(
      `SELECT c.set_id AS set_id, COUNT(DISTINCT ci.card_id) AS owned
       FROM collection_items ci JOIN cards c ON c.id = ci.card_id
       WHERE ci.user_id = ? GROUP BY c.set_id`,
    )
    .all(user.id) as { set_id: string; owned: number }[];
  const ownedBySet = new Map(ownedRows.map((r) => [r.set_id, r.owned]));

  const cards: SetCard[] = sets.map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    releaseDate: s.release_date,
    printedTotal: s.printed_total,
    total: s.total,
    logoUrl: s.logo_url,
    symbolUrl: s.symbol_url,
    mainSetCents: valueBySet.get(s.id)?.cents ?? 0,
    mainSetSlots: valueBySet.get(s.id)?.slots ?? 0,
    ownedCards: ownedBySet.get(s.id) ?? 0,
    trackedMode: trackedModes.get(s.id) ?? null,
  }));

  return (
    <>
      <TopBar title="Sets" subtitle={`${sets.length} English sets · 20,444 cards`} />
      <main className="px-4 pb-8 pt-4">
        <SetBrowser sets={cards} />
      </main>
    </>
  );
}
