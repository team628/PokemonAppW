import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
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
  const user = await currentUser();
  if (!user) redirect('/signin');

  // One aggregate in the database rather than a set list plus a value map in
  // the app: the main-set figure uses the same slot valuation the completion
  // engine uses, so onboarding and the set page cannot disagree.
  const rows = await withIdentity(user.id, (tx) =>
    tx.rows<{
      id: string; name: string; series: string; release_date: string | null;
      printed_total: number; symbol_url: string | null; main_set_cents: number;
    }>(
      `select s.id, s.name, s.series, s.release_date::text, s.printed_total, s.symbol_url,
              coalesce(v.cents, 0)::bigint as main_set_cents
       from public.sets s
       left join (
         select c.set_id,
                sum(public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents)) as cents
         from public.cards c
         join public.card_variants cv on cv.card_id = c.id and cv.is_primary
         left join public.prices p
           on p.card_id = c.id and p.variant = cv.variant and p.provider = 'tcgplayer'
         where not c.is_secret
         group by c.set_id
       ) v on v.set_id = s.id
       order by s.release_date desc nulls last, s.name`,
    ),
  );

  const sets: OnboardSet[] = rows.map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    releaseDate: s.release_date,
    printedTotal: s.printed_total,
    symbolUrl: s.symbol_url,
    mainSetCents: s.main_set_cents,
  }));

  return <Onboarding sets={sets} />;
}
