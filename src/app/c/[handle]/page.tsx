import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { publicCollection, publicMissing } from '@/lib/services/pg/profile';
import { money } from '@/lib/pricing/quote';
import { GOAL_MODES } from '@/lib/domain/goals';
import { CardArt, Progress } from '@/components/ui';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const data = await publicCollection(handle);
  if (!data) return { title: 'Not found — SetValue' };
  const best = data.goals[0];
  return {
    title: `${data.profile.display_name} on SetValue`,
    description: best
      ? `${(best.percent * 100).toFixed(1)}% through ${best.setName} — ${money(best.needCents)} to go.`
      : `${data.profile.display_name}'s Pokémon collection on SetValue.`,
  };
}

/**
 * Public collection page.
 *
 * Shows progress and set values — the things a collector wants to show off —
 * and never shows purchase prices, email, or anything about where cards were
 * bought. Sharing should not cost privacy.
 *
 * The read runs as an anonymous visitor, so the privacy guarantee is enforced
 * by row-level security rather than by this component remembering to check a
 * flag: a private collection is simply unreadable on this path.
 */
export default async function PublicCollection({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const data = await publicCollection(handle);
  // A private collection is indistinguishable from one that does not exist.
  // Rendering a "this is private" page would confirm the handle is taken and
  // let anyone enumerate which collectors are on SetValue.
  if (!data) notFound();

  const { profile, goals } = data;
  const completed = goals.filter((g) => g.ownedCount >= g.requiredCount && g.requiredCount > 0);
  const headline = goals[0];
  const stillHunting =
    headline && headline.ownedCount < headline.requiredCount
      ? await publicMissing(handle, headline.setId, headline.mode, 20)
      : [];

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-16">
      <header className="flex items-center justify-between py-5">
        <Link href="/" className="text-base font-black tracking-tight">
          SET<span className="text-need">VALUE</span>
        </Link>
        <Link href="/signup" className="rounded-full bg-white px-3 py-1.5 text-xs font-bold text-ink">
          Track your sets
        </Link>
      </header>

      <section className="flex items-center gap-4 pt-4">
        <span
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-2xl font-black text-ink"
          style={{ background: profile.avatar_color }}
        >
          {profile.display_name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{profile.display_name}</h1>
          <p className="text-xs text-ink-mute">
            @{profile.handle} · collecting on SetValue since{' '}
            {new Date(profile.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </p>
        </div>
      </section>

      <section className="panel mt-6 grid grid-cols-3 gap-px overflow-hidden bg-ink-line">
        <Cell label="Cards" value={data.totalCards.toLocaleString()} />
        <Cell label="Sets chased" value={String(goals.length)} />
        <Cell label="Finished" value={String(completed.length)} />
      </section>

      {headline && (
        <section className="panel mt-4 px-5 py-5">
          <p className="label">Closest to done</p>
          <p className="mt-1 text-lg font-bold">{headline.setName}</p>
          <p className="num mt-3 text-4xl font-black text-need">
            {headline.ownedCount >= headline.requiredCount ? 'COMPLETE' : money(headline.needCents)}
          </p>
          <p className="mt-1 text-xs text-ink-mute">
            {headline.ownedCount >= headline.requiredCount
              ? `All ${headline.requiredCount} cards`
              : `${headline.requiredCount - headline.ownedCount} cards to go`}
          </p>
          <Progress
            value={headline.percent}
            tone={headline.ownedCount >= headline.requiredCount ? 'have' : 'need'}
            className="mt-3"
          />
          <p className="num mt-2 text-xs font-semibold">
            {(headline.percent * 100).toFixed(1)}% complete
          </p>
        </section>
      )}

      <section className="mt-6">
        <h2 className="label mb-3">Progress</h2>
        {goals.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-mute">
            No sets tracked publicly yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {goals.map((g) => {
              const done = g.requiredCount > 0 && g.ownedCount >= g.requiredCount;
              return (
                <li key={g.goalId} className="panel flex items-center gap-3 px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{g.setName}</p>
                    <p className="num text-[11px] text-ink-mute">
                      {GOAL_MODES.find((m) => m.id === g.mode)?.label} ·{' '}
                      {g.ownedCount}/{g.requiredCount}
                    </p>
                    <Progress value={g.percent} tone={done ? 'have' : 'need'} className="mt-2" />
                  </div>
                  <div className="shrink-0 text-right">
                    {done ? (
                      <span className="text-xs font-black text-have">DONE</span>
                    ) : (
                      <>
                        <p className="num text-sm font-bold text-need">{money(g.needCents)}</p>
                        <p className="num text-[10px] text-ink-mute">{(g.percent * 100).toFixed(1)}%</p>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {headline && stillHunting.length > 0 && (
        <section className="mt-6">
          <h2 className="label mb-3">Still hunting · {headline.setName}</h2>
          <ul className="rail flex gap-2 overflow-x-auto pb-1">
            {stillHunting.map((m) => (
              <li key={`${m.cardId}-${m.variant}`} className="w-[74px] shrink-0">
                <CardArt src={m.imageSmall} alt={m.name} owned={false} label={`#${m.number}`} />
                <p className="num mt-1 truncate text-center text-[10px] text-ink-mute">#{m.number}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="mt-10 border-t border-ink-line pt-6 text-xs text-ink-mute">
        <p>
          Progress and set values are computed from TCGplayer market prices. Purchase prices,
          contact details and collection locations are never shown on a public page.
        </p>
        <p className="mt-3">
          <Link href="/signup" className="font-semibold text-white underline">
            Build your own
          </Link>
        </p>
      </footer>
    </main>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-soft px-3 py-3 text-center">
      <p className="label">{label}</p>
      <p className="num mt-1 text-lg font-bold">{value}</p>
    </div>
  );
}
