import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { myGoals } from '@/lib/services/pg';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { Empty, SourceNote } from '@/components/ui';
import { BinderPages, type BinderSlot } from '@/components/BinderPages';
import type { GoalMode } from '@/lib/domain/goals';
import type { Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

export default async function BinderPage({
  searchParams,
}: { searchParams: Promise<{ set?: string; mode?: string; pocket?: string }> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const goals = await myGoals(user.id);
  const setId = sp.set ?? goals[0]?.setId;

  if (!setId) {
    return (
      <>
        <TopBar title="Binder" back="/app" />
        <main className="px-4 pt-4">
          <Empty title="Binder view needs a set"
            body="Pick a set and SetValue lays it out exactly as it sits in a binder — page by page, pocket by pocket, with the holes visible."
            action={{ href: '/app/sets', label: 'Choose a set' }} />
        </main>
      </>
    );
  }

  const mode: GoalMode =
    (['main', 'complete', 'master'] as const).find((m) => m === sp.mode) ??
    goals.find((g) => g.setId === setId)?.mode ?? 'main';

  const { setName, rows } = await withIdentity(user.id, async (tx) => {
    const s = await tx.one<{ name: string }>('select name from public.sets where id = $1', [setId]);
    const rows = await tx.rows<{
      card_id: string; variant: string; number: string; name: string;
      image_small: string | null; market_cents: number | null; quantity: number;
    }>('select * from public.set_grid($1, $2)', [setId, mode]);
    return { setName: s?.name ?? setId, rows };
  });

  const slots: BinderSlot[] = rows.map((r) => ({
    cardId: r.card_id, variant: r.variant as Variant, number: r.number, name: r.name,
    imageSmall: r.image_small, marketCents: r.market_cents, owned: r.quantity > 0,
  }));
  const filled = slots.filter((s) => s.owned).length;

  return (
    <>
      <TopBar title={`${setName} binder`} subtitle={`${filled}/${slots.length} pockets filled`}
        back={`/app/sets/${setId}?mode=${mode}`} />
      <main className="px-4 pb-8 pt-4">
        <BinderPages slots={slots} setName={setName}
          initialPocket={sp.pocket === '4' ? 4 : sp.pocket === '12' ? 12 : 9} />
        <div className="mt-5 flex gap-2">
          <Link href={`/app/binder/pull?set=${setId}&mode=${mode}`} className="btn-ghost flex-1">Printable pull list</Link>
          <Link href={`/app/show?set=${setId}&mode=${mode}`} className="btn-ghost flex-1">Card Show mode</Link>
        </div>
        <SourceNote className="mt-5 border-t border-ink-line pt-4">
          Pages are laid out in card-number order, which is how a set binder is filled. Empty
          pockets are the cards you are missing — the same list Card Show mode hands you when you
          are standing at a table.
        </SourceNote>
      </main>
    </>
  );
}
