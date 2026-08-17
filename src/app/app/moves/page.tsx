import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { buildInsights } from '@/lib/services/insights';
import { TopBar } from '@/components/AppShell';
import { MoveCard } from '@/components/MoveCard';
import { Empty, SourceNote } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function MovesPage({
  searchParams,
}: {
  searchParams: Promise<{ budget?: string }>;
}) {
  const sp = await searchParams;
  const user = await requireUser();
  const db = getDb();

  const budget = sp.budget ? Math.round(parseFloat(sp.budget) * 100) : null;
  const insights = buildInsights(db, user.id, Number.isFinite(budget as number) ? budget : null);

  return (
    <>
      <TopBar
        title="Next Best Move"
        subtitle={`${insights.moves.length} ranked option${insights.moves.length === 1 ? '' : 's'}`}
        back="/app"
      />
      <main className="px-4 pb-8 pt-4">
        <form className="panel mb-4 flex items-end gap-2 px-3.5 py-3" action="/app/moves">
          <div className="flex-1">
            <label className="label" htmlFor="budget">Budget (optional)</label>
            <input
              id="budget"
              name="budget"
              type="number"
              inputMode="decimal"
              step="1"
              min="0"
              defaultValue={budget ? (budget / 100).toString() : ''}
              placeholder="50"
              className="field mt-1 py-2.5"
            />
          </div>
          <button className="btn-primary h-[46px]">Re-rank</button>
        </form>

        {insights.moves.length === 0 ? (
          <Empty
            title="Nothing to recommend yet"
            body="Next Best Move works from tracked sets and current prices. Track a set and recommendations appear immediately."
            action={{ href: '/app/sets', label: 'Track a set' }}
          />
        ) : (
          <div className="space-y-3">
            {insights.moves.map((m, i) => (
              <MoveCard key={`${m.kind}-${m.goalId ?? i}`} move={m} primary={i === 0} />
            ))}
          </div>
        )}

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Moves are ranked by completion gained per dollar, weighted toward sets already close to
          finished. Every card shown is one SetValue believes you are missing, at a price a provider
          quoted on a stated date.
          {insights.historyTooShallow &&
            ' Price-movement moves are withheld: SetValue currently holds a single dated reading per card, and one point is not a trend.'}
        </SourceNote>
      </main>
    </>
  );
}
