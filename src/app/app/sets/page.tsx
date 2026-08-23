import { requireUser } from '@/lib/auth/session';
import { listSets } from '@/lib/services/pg';
import { TopBar } from '@/components/AppShell';
import { SetBrowser, type SetCard } from '@/components/SetBrowser';

export const dynamic = 'force-dynamic';

export default async function SetsPage() {
  const user = await requireUser();
  const rows = await listSets(user.id);

  const cards: SetCard[] = rows.map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    releaseDate: s.release_date,
    printedTotal: s.printed_total,
    total: s.total,
    logoUrl: s.logo_url,
    symbolUrl: s.symbol_url,
    mainSetCents: s.main_set_cents,
    mainSetSlots: 0,
    ownedCards: s.owned_cards,
    trackedMode: s.tracked_mode,
  }));

  return (
    <>
      <TopBar title="Sets" subtitle={`${rows.length} English sets`} />
      <main className="px-4 pb-8 pt-4">
        <SetBrowser sets={cards} />
      </main>
    </>
  );
}
