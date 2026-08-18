import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { CardArt } from '@/components/CardArt';
import { Empty, Money, SectionTitle } from '@/components/ui';
import { MILESTONE_COPY, type MilestoneKind } from '@/lib/domain/goals';
import { listSessions } from '@/lib/services/pg/show';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

interface EventRow {
  id: string;
  type: string;
  set_id: string | null;
  card_id: string | null;
  payload: { finds?: number; spentCents?: number; quantity?: number } | null;
  created_at: string;
  card_name: string | null;
  card_number: string | null;
  card_image: string | null;
  set_name: string | null;
  market_cents: number | null;
}

interface MilestoneRow {
  kind: string;
  achieved_at: string;
  set_id: string;
  set_name: string;
  logo_url: string | null;
  payload: { ownedCount?: number; requiredCount?: number; completeCents?: number } | null;
}

/** Milestones the product treats as headline moments, most significant first. */
const HEADLINE: MilestoneKind[] = ['complete', 'one_left', 'final_five', 'pct90', 'pct75', 'pct50'];

export default async function JourneyPage() {
  const user = await requireUser();

  const [{ events, milestones, completed, first, totals }, sessions] = await Promise.all([
    withIdentity(user.id, async (tx) => {
      const events = await tx.rows<EventRow>(
        `select e.id::text, e.type, e.set_id, e.card_id, e.payload, e.created_at::text,
                c.name as card_name, c.number as card_number, c.image_small as card_image,
                s.name as set_name,
                public.slot_market_cents(p.market_cents, p.mid_cents, p.low_cents) as market_cents
         from public.collection_events e
         left join public.cards c on c.id = e.card_id
         left join public.sets s on s.id = e.set_id
         left join public.prices p
           on p.card_id = e.card_id and p.provider = 'tcgplayer'
          and p.variant = coalesce(e.payload->>'variant', 'normal')
         where e.user_id = $1::uuid
         order by e.created_at desc
         limit 200`,
        [user.id],
      );

      const milestones = await tx.rows<MilestoneRow>(
        `select m.kind, m.achieved_at::text, g.set_id, s.name as set_name, s.logo_url, m.payload
         from public.milestones m
         join public.set_goals g on g.id = m.goal_id
         join public.sets s on s.id = g.set_id
         where m.user_id = $1::uuid
         order by m.achieved_at desc
         limit 40`,
        [user.id],
      );

      const completed = await tx.rows<{ completed_at: string; name: string; id: string; logo_url: string | null }>(
        `select g.completed_at::text, s.name, s.id, s.logo_url
         from public.set_goals g join public.sets s on s.id = g.set_id
         where g.user_id = $1::uuid and g.completed_at is not null
         order by g.completed_at desc`,
        [user.id],
      );

      const first = await tx.one<{ first: string | null }>(
        'select min(created_at)::text as first from public.collection_events where user_id = $1::uuid',
        [user.id],
      );

      const totals = await tx.one<{ cards: number; acquisitions: number }>(
        `select coalesce(sum(quantity), 0)::int as cards,
                (select count(*) from public.collection_events
                  where user_id = $1::uuid and type in ('card_acquired','copy_added'))::int as acquisitions
         from public.collection_items where user_id = $1::uuid`,
        [user.id],
      );

      return { events, milestones, completed, first, totals };
    }),
    listSessions(user.id, 10),
  ]);

  const hunts = sessions.filter((h) => h.finds > 0);
  const totalFinds = hunts.reduce((s, h) => s + h.finds, 0);
  const headline = milestones.filter((m) => HEADLINE.includes(m.kind as MilestoneKind)).slice(0, 8);

  // Grouped by calendar day — a collection is remembered in days, not timestamps.
  const byDay = new Map<string, EventRow[]>();
  for (const e of events) {
    const day = e.created_at.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  return (
    <>
      <TopBar title="Your journey" back="/app" />
      <main className="space-y-7 px-4 pb-8 pt-4">
        {events.length === 0 ? (
          <Empty
            title="Your history starts with the first card"
            body="Everything you add, every milestone you hit and every hunt you log is kept here in order, so a collection built over years reads like the story it is."
            action={{ href: '/app/sets', label: 'Add your first card' }}
          />
        ) : (
          <>
            <section className="panel-raise px-5 py-4">
              <p className="label">Collecting since</p>
              <p className="mt-1 text-2xl font-extrabold">
                {first?.first
                  ? new Date(first.first).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                  : '—'}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                  <p className="label">Cards</p>
                  <p className="num mt-1 text-[15px] font-bold">{totals?.cards.toLocaleString()}</p>
                </div>
                <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                  <p className="label">Sets done</p>
                  <p className="num mt-1 text-[15px] font-bold text-have">{completed.length}</p>
                </div>
                <div className="rounded-xl border border-ink-line bg-ink/60 px-3 py-2.5">
                  <p className="label">Hunt finds</p>
                  <p className="num mt-1 text-[15px] font-bold">{totalFinds}</p>
                </div>
              </div>
            </section>

            {/* --------------------------------------------- earned moments */}
            {headline.length > 0 && (
              <section>
                <SectionTitle>Moments</SectionTitle>
                <ul className="rail rail-bleed flex gap-2.5 overflow-x-auto pb-1">
                  {headline.map((m, i) => {
                    const copy = MILESTONE_COPY[m.kind as MilestoneKind];
                    const finished = m.kind === 'complete';
                    return (
                      <li key={`${m.kind}-${m.set_id}-${i}`} className="w-[180px] shrink-0">
                        <Link
                          href={`/app/sets/${m.set_id}`}
                          className={`panel relative block h-full overflow-hidden px-3.5 py-3 ${
                            finished ? 'border-gold/35' : ''
                          }`}
                        >
                          {m.logo_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={m.logo_url}
                              alt=""
                              aria-hidden
                              loading="lazy"
                              className="pointer-events-none absolute -right-3 -top-2 h-14 opacity-[0.09]"
                            />
                          )}
                          <div
                            aria-hidden
                            className={`pointer-events-none absolute inset-0 ${
                              finished ? 'bg-gradient-to-b from-gold/[.12]' : 'bg-gradient-to-b from-have/[.08]'
                            } to-transparent`}
                          />
                          <div className="relative">
                            <p className={`text-[13px] font-black ${finished ? 'text-gold' : 'text-have'}`}>
                              {copy?.title ?? m.kind}
                            </p>
                            <p className="mt-1 truncate text-[11px] font-semibold">{m.set_name}</p>
                            <p className="num mt-2 text-[10px] text-ink-mute">
                              {new Date(m.achieved_at).toLocaleDateString('en-US', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </p>
                          </div>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {completed.length > 0 && (
              <section>
                <SectionTitle>Finished sets</SectionTitle>
                <ul className="space-y-2">
                  {completed.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/app/sets/${c.id}`}
                        className="panel relative flex items-center gap-3 overflow-hidden px-3.5 py-3"
                      >
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-0 bg-gradient-to-r from-gold/[.07] to-transparent"
                        />
                        <span aria-hidden className="relative text-xl">🏆</span>
                        <div className="relative min-w-0 flex-1">
                          <p className="truncate text-[13px] font-bold">{c.name}</p>
                          <p className="text-[10px] text-ink-mute">
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
                      <span aria-hidden className="text-lg">🎒</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold">{h.name}</p>
                        <p className="num text-[10px] text-ink-mute">
                          {new Date(h.started_at).toLocaleDateString()} · {h.finds} card
                          {h.finds === 1 ? '' : 's'} · {money(h.spent_cents)} spent
                        </p>
                      </div>
                      {h.edge_cents !== null && (
                        <span
                          className={`num shrink-0 text-[12px] font-bold ${
                            h.edge_cents >= 0 ? 'text-have' : 'text-need'
                          }`}
                        >
                          {h.edge_cents >= 0 ? '+' : '−'}
                          {money(Math.abs(h.edge_cents))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ------------------------------------------------- the timeline */}
            <section>
              <SectionTitle>Timeline</SectionTitle>
              <div className="space-y-5">
                {[...byDay.entries()].map(([day, rows]) => {
                  const cards = rows.filter((e) => e.card_image && e.type !== 'card_removed');
                  return (
                    <div key={day}>
                      <p className="num mb-2 text-[10px] font-semibold uppercase tracking-[.14em] text-ink-mute">
                        {new Date(`${day}T12:00:00`).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })}
                      </p>

                      {cards.length > 0 && (
                        <ul className="rail rail-bleed mb-2 flex gap-1.5 overflow-x-auto pb-1">
                          {cards.slice(0, 20).map((e) => (
                            <li key={`art-${e.id}`} className="w-[46px] shrink-0">
                              <Link href={`/app/cards/${e.card_id}`}>
                                <CardArt
                                  src={e.card_image}
                                  alt={e.card_name ?? ''}
                                  label={`#${e.card_number ?? ''}`}
                                />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}

                      <ul className="space-y-1.5 border-l border-ink-line pl-3.5">
                        {rows.map((e) => (
                          <li key={e.id} className="relative">
                            <span
                              aria-hidden
                              className={`absolute -left-[19px] top-1.5 h-2 w-2 rounded-full ${
                                e.type.startsWith('milestone') ? 'bg-gold' : 'bg-ink-line'
                              }`}
                            />
                            <p className="text-[13px]">{describe(e)}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </main>
    </>
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
      return (
        <>
          Added <span className="font-semibold">{card}</span>
          {e.market_cents !== null && (
            <span className="num text-ink-mute">
              {' '}
              · <Money cents={e.market_cents} />
            </span>
          )}
        </>
      );
    case 'copy_added':
      return (
        <>
          Another copy of <span className="font-semibold">{card}</span>
        </>
      );
    case 'card_removed':
      return <span className="text-ink-mute">Removed {card}</span>;
    case 'goal_added':
      return (
        <>
          Started chasing <span className="font-semibold">{set}</span>
        </>
      );
    case 'show_started':
      return <span className="text-ink-mute">Started a hunt</span>;
    case 'show_ended': {
      const p = e.payload ?? {};
      return (
        <>
          Finished a hunt — <span className="font-semibold">{p.finds ?? 0} cards</span>
          {typeof p.spentCents === 'number' && (
            <span className="text-ink-mute"> · {money(p.spentCents)}</span>
          )}
        </>
      );
    }
    default:
      return <span className="text-ink-mute">{e.type}</span>;
  }
}
