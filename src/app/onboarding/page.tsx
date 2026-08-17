import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { listSets } from '@/lib/repo/catalog';
import { Onboarding, type OnboardSet } from '@/components/Onboarding';

export const dynamic = 'force-dynamic';

/**
 * First run.
 *
 * The fastest route to SetValue being useful is one tracked set, so onboarding
 * asks for exactly that and nothing else. Everything the product can do follows
 * from knowing what someone is chasing.
 */
export default async function OnboardingPage() {
  // Deliberately outside the app shell: there is no bottom navigation here,
  // because there is nothing to navigate to until a set is being tracked — and
  // a fixed nav bar would sit on top of this screen's primary action.
  if (!(await currentUser())) redirect('/signin');
  const db = getDb();

  const values = db
    .prepare(
      `SELECT c.set_id AS set_id, SUM(COALESCE(p.market_cents, p.mid_cents, p.low_cents, 0)) AS cents
       FROM cards c
       JOIN card_variants v ON v.card_id = c.id AND v.is_primary = 1
       LEFT JOIN prices p ON p.card_id = c.id AND p.variant = v.variant AND p.provider='tcgplayer'
       WHERE c.is_secret = 0 GROUP BY c.set_id`,
    )
    .all() as { set_id: string; cents: number }[];
  const valueBySet = new Map(values.map((v) => [v.set_id, v.cents]));

  const sets: OnboardSet[] = listSets(db).map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    releaseDate: s.release_date,
    printedTotal: s.printed_total,
    symbolUrl: s.symbol_url,
    mainSetCents: valueBySet.get(s.id) ?? 0,
  }));

  return <Onboarding sets={sets} />;
}
