import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getDb } from '@/lib/db';
import { goalViews } from '@/lib/services/goals';
import { portfolioSummary } from '@/lib/services/collection';
import { money } from '@/lib/pricing/quote';
import { GOAL_MODES } from '@/lib/domain/goals';
import { CardArt, Progress } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface PublicUser {
  id: string;
  handle: string;
  display_name: string;
  avatar_color: string;
  created_at: string;
  share_public: number;
}

function load(handle: string): PublicUser | undefined {
  return getDb()
    .prepare('SELECT id, handle, display_name, avatar_color, created_at, share_public FROM users WHERE handle = ?')
    .get(handle) as PublicUser | undefined;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const user = load(handle);
  if (!user || user.share_public !== 1) return { title: 'SetValue' };
  const views = goalViews(getDb(), user.id);
  const best = [...views].sort((a, b) => b.metrics.percent - a.metrics.percent)[0];
  return {
    title: `${user.display_name} on SetValue`,
    description: best
      ? `${(best.metrics.percent * 100).toFixed(1)}% through ${best.set.name} — ${money(best.metrics.needCents)} to go.`
      : `${user.display_name}'s Pokémon collection on SetValue.`,
  };
}

/**
 * Public collection page.
 *
 * Shows progress and set values — the things a collector wants to show off —
 * and never shows purchase prices, email, or anything about where cards were
 * bought. Sharing should not cost privacy.
 */
export default async function PublicCollection({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const user = load(handle);
  if (!user) notFound();

  if (user.share_public !== 1) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 text-center">
        <p className="text-lg font-bold">This collection is private</p>
        <p className="mt-2 text-sm text-ink-mute">@{handle} has not made their page public.</p>
      </main>
    );
  }

  const db = getDb();
  const views = goalViews(db, user.id).sort((a, b) => b.metrics.percent - a.metrics.percent);
  const summary = portfolioSummary(db, user.id);
  const completed = views.filter((v) => v.metrics.missingCount === 0);
  const headline = views[0];

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
          style={{ background: user.avatar_color }}
        >
          {user.display_name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-bold">{user.display_name}</h1>
          <p className="text-xs text-ink-mute">
            @{user.handle} · collecting on SetValue since{' '}
            {new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </p>
        </div>
      </section>

      <section className="panel mt-6 grid grid-cols-3 gap-px overflow-hidden bg-ink-line">
        <Cell label="Cards" value={summary.totalCards.toLocaleString()} />
        <Cell label="Sets chased" value={String(views.length)} />
        <Cell label="Finished" value={String(completed.length)} />
      </section>

      {headline && (
        <section className="panel mt-4 px-5 py-5">
          <p className="label">Closest to done</p>
          <p className="mt-1 text-lg font-bold">{headline.set.name}</p>
          <p className="num mt-3 text-4xl font-black text-need">
            {headline.metrics.missingCount === 0 ? 'COMPLETE' : money(headline.metrics.needCents)}
          </p>
          <p className="mt-1 text-xs text-ink-mute">
            {headline.metrics.missingCount === 0
              ? `All ${headline.metrics.requiredCount} cards`
              : `${headline.metrics.missingCount} cards to go`}
          </p>
          <Progress value={headline.metrics.percent} tone={headline.metrics.missingCount === 0 ? 'have' : 'need'} className="mt-3" />
          <p className="num mt-2 text-xs font-semibold">
            {(headline.metrics.percent * 100).toFixed(1)}% complete
          </p>
        </section>
      )}

      <section className="mt-6">
        <h2 className="label mb-3">Progress</h2>
        {views.length === 0 ? (
          <p className="panel px-4 py-8 text-center text-sm text-ink-mute">
            No sets tracked publicly yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {views.map((v) => (
              <li key={v.goal.id} className="panel flex items-center gap-3 px-3.5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{v.set.name}</p>
                  <p className="num text-[11px] text-ink-mute">
                    {GOAL_MODES.find((m) => m.id === v.goal.mode)?.label} ·{' '}
                    {v.metrics.ownedCount}/{v.metrics.requiredCount}
                  </p>
                  <Progress
                    value={v.metrics.percent}
                    tone={v.metrics.missingCount === 0 ? 'have' : 'need'}
                    className="mt-2"
                  />
                </div>
                <div className="shrink-0 text-right">
                  {v.metrics.missingCount === 0 ? (
                    <span className="text-xs font-black text-have">DONE</span>
                  ) : (
                    <>
                      <p className="num text-sm font-bold text-need">{money(v.metrics.needCents)}</p>
                      <p className="num text-[10px] text-ink-mute">{(v.metrics.percent * 100).toFixed(1)}%</p>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {headline && headline.metrics.missing.length > 0 && (
        <section className="mt-6">
          <h2 className="label mb-3">Still hunting · {headline.set.name}</h2>
          <ul className="rail flex gap-2 overflow-x-auto pb-1">
            {headline.metrics.missing.slice(0, 20).map((m) => (
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
