import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { Empty, SectionTitle, SourceNote } from '@/components/ui';
import { MILESTONE_COPY, type MilestoneKind } from '@/lib/domain/goals';
import { listSessions } from '@/lib/services/pg/show';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

interface EventRow {
  id: string;
  type: string;
  set_id: string | null;
  card_id: string | null;
  payload: { finds?: number; spentCents?: number } | null;
  created_at: string;
  card_name: string | null;
  card_number: string | null;
  set_name: string | null;
}

export default async function JourneyPage() {
  const user = await requireUser();

  const [{ events, completed, firstEvent }, sessions] = await Promise.all([
    withIdentity(user.id, async (tx) => {
      const events = await tx.rows<EventRow>(
        `select e.id::text, e.type, e.set_id, e.card_id, e.payload, e.created_at::text,
                c.name as card_name, c.number as card_number, s.name as set_name
         from public.collection_events e
         left join public.cards c on c.id = e.card_id
         left join public.sets s on s.id = e.set_id
         where e.user_id = $1::uuid
         order by e.created_at desc
         limit 200`,
        [user.id],
      );

      const completed = await tx.rows<{ completed_at: string; name: string; id: string }>(
        `select g.completed_at::text, s.name, s.id
         from public.set_goals g join public.sets s on s.id = g.set_id
         where g.user_id = $1::uuid and g.completed_at is not null
         order by g.completed_at desc`,
        [user.id],
      );

      const firstEvent = await tx.one<{ first: string | null }>(
        'select min(created_at)::text as first from public.collection_events where user_id = $1::uuid',
        [user.id],
      );

      return { events, completed, firstEvent };
    }),
    listSessions(user.id, 10),
  ]);

  const hunts = sessions.filter((h) => h.finds > 0);
  const totalFinds = hunts.reduce((s, h) => s + h.finds, 0);

  // Group the feed by calendar day — a collection is remembered in days, not
  // timestamps ("the day we finished the binder", not 14:07:22).
  const byDay = new Map<string, EventRow[]>();
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  return (
    <>
      <TopBar title="Your journey" subtitle="Every card, every milestone, in order" back="/app" />
      <main className="space-y-6 px-4 pb-8 pt-4">
        {events.length === 0 ? (
          <Empty
            title="Your history starts with the first card"
            body="Everything you add, every milestone you hit and every hunt you log is kept here in order, so a collection built over years reads like the story it is."
            action={{ href: '/app/sets', label: 'Add your first card' }}
          />
        ) : (
          <>
            <section className="panel grid grid-cols-3 gap-px overflow-hidden bg-ink-line">
              <Cell label="Collecting since" value={firstEvent?.first ? new Date(firstEvent.first).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : '—'} />
              <Cell label="Sets finished" value={String(completed.length)} />
              <Cell label="Hunt finds" value={String(totalFinds)} />
            </section>

            {completed.length > 0 && (
              <section>
                <SectionTitle>Finished sets</SectionTitle>
                <ul className="space-y-2">
                  {completed.map((c) => (
                    <li key={c.id}>
                      <Link href={`/app/sets/${c.id}`} className="panel flex items-center gap-3 px-3.5 py-3">
                        <span aria-hidden className="text-xl">🏆</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold">{c.name}</p>
                          <p className="text-[11px] text-ink-mute">
                            Completed {new Date(c.completed_at).toLocaleDateString()}
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {hunts.length > 0 && (
              <section>
                <SectionTitle>Hunts</SectionTitle>
                <ul className="space-y-2">
                  {hunts.map((h) => (
                    <li key={h.id} className="panel flex items-center gap-3 px-3.5 py-3">
                      <span aria-hidden className="text-xl">🎒</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{h.name}</p>
                        <p className="num text-[11px] text-ink-mute">
                          {new Date(h.started_at).toLocaleDateString()} · {h.finds} card
                          {h.finds === 1 ? '' : 's'} · {money(h.spent_cents)} spent
                        </p>
                      </div>
                      {h.edge_cents !== null && (
                        <span className={`num shrink-0 text-xs font-bold ${h.edge_cents >= 0 ? 'text-have' : 'text-need'}`}>
                          {h.edge_cents >= 0 ? '+' : '−'}
                          {money(Math.abs(h.edge_cents))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <SectionTitle>Timeline</SectionTitle>
              <div className="space-y-5">
                {[...byDay.entries()].map(([day, rows]) => (
                  <div key={day}>
                    <p className="num mb-2 text-[11px] font-semibold uppercase tracking-[.14em] text-ink-mute">
                      {new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
                        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
                      })}
                    </p>
                    <ul className="space-y-1.5 border-l border-ink-line pl-3.5">
                      {rows.map((e) => (
                        <li key={e.id} className="relative">
                          <span
                            aria-hidden
                            className={`absolute -left-[19px] top-1.5 h-2 w-2 rounded-full ${
                              e.type.startsWith('milestone') ? 'bg-gold' : 'bg-ink-line'
                            }`}
                          />
                          <p className="text-sm">{describe(e)}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}

        <SourceNote className="border-t border-ink-line pt-4">
          Milestones are recorded once, when they are first reached, and are never re-fired if a
          collection dips and climbs again. The moment belongs to the day it happened.
        </SourceNote>
      </main>
    </>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-ink-soft px-3 py-3 text-center">
      <p className="label">{label}</p>
      <p className="num mt-1 text-base font-bold">{value}</p>
    </div>
  );
}

function describe(e: EventRow): React.ReactNode {
  const card = e.card_name ? `${e.card_name}${e.card_number ? ` #${e.card_number}` : ''}` : 'a card';
  const set = e.set_name ?? 'a set';

  if (e.type.startsWith('milestone:')) {
    const kind = e.type.slice('milestone:'.length) as MilestoneKind;
    const copy = MILESTONE_COPY[kind];
    return (
      <span className="font-semibold text-gold">
        {copy?.title ?? kind} — {set}
      </span>
    );
  }
  switch (e.type) {
    case 'card_acquired':
      return <>Added <span className="font-semibold">{card}</span> <span className="text-ink-mute">· {set}</span></>;
    case 'copy_added':
      return <>Another copy of <span className="font-semibold">{card}</span></>;
    case 'card_removed':
      return <span className="text-ink-mute">Removed {card}</span>;
    case 'goal_added':
      return <>Started chasing <span className="font-semibold">{set}</span></>;
    case 'show_started':
      return <span className="text-ink-mute">Started a hunt</span>;
    case 'show_ended': {
      // jsonb comes back already parsed by the driver.
      const p = e.payload ?? {};
      return (
        <>
          Finished a hunt — <span className="font-semibold">{p.finds ?? 0} cards</span>
          {typeof p.spentCents === 'number' && <span className="text-ink-mute"> · {money(p.spentCents)}</span>}
        </>
      );
    }
    default:
      return <span className="text-ink-mute">{e.type}</span>;
  }
}
