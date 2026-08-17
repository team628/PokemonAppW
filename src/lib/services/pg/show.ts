import { withIdentity } from '../../db/pg';
import type { Variant } from '../../catalog/variants';
import type { Condition } from '../../domain/conditions';

/**
 * Card Show hunts.
 *
 * A find records the market value at the moment it happened alongside what was
 * paid, because "I picked this up for $4 when it was booking at $19" is the
 * story a collector wants back later, and a price looked up next month cannot
 * tell it.
 */

export interface ShowSession {
  id: string;
  name: string;
  venue: string | null;
  started_at: string;
  ended_at: string | null;
  budget_cents: number | null;
}

/**
 * The open hunt, started if there isn't one.
 *
 * A partial unique index enforces at most one open session per collector, so
 * two concurrent requests cannot open two — the loser conflicts and reads the
 * winner's row instead of racing into a duplicate.
 */
export async function currentOrNewSession(userId: string, name?: string): Promise<ShowSession> {
  return withIdentity(userId, async (tx) => {
    const open = await tx.one<ShowSession>(
      'select id, name, venue, started_at::text, ended_at::text, budget_cents from public.show_sessions where ended_at is null limit 1',
    );
    if (open) return open;

    const label =
      name?.trim() ||
      `Hunt · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    const created = await tx.one<ShowSession>(
      `insert into public.show_sessions (user_id, name) values ($1::uuid, $2)
       on conflict do nothing
       returning id, name, venue, started_at::text, ended_at::text, budget_cents`,
      [userId, label],
    );
    if (created) {
      await tx.exec(
        `insert into public.collection_events (user_id, type, payload)
         values ($1::uuid, 'show_started', jsonb_build_object('sessionId', $2::text))`,
        [userId, created.id],
      );
      return created;
    }

    // Lost the race — read the session the other request opened.
    return (await tx.one<ShowSession>(
      'select id, name, venue, started_at::text, ended_at::text, budget_cents from public.show_sessions where ended_at is null limit 1',
    ))!;
  });
}

export interface SessionSummary {
  finds: number;
  spentCents: number;
  marketCents: number;
  edgeCents: number | null;
  pricedFinds: number;
}

export async function sessionSummary(userId: string, sessionId: string): Promise<SessionSummary> {
  return withIdentity(userId, async (tx) => {
    const r = (await tx.one<{
      finds: number; spent: number; market: number; edge: number; priced: number;
    }>(
      `select count(*)::int as finds,
              coalesce(sum(paid_cents), 0)::bigint as spent,
              coalesce(sum(market_cents), 0)::bigint as market,
              coalesce(sum(market_cents - paid_cents)
                       filter (where paid_cents is not null and market_cents is not null), 0)::bigint as edge,
              count(*) filter (where paid_cents is not null and market_cents is not null)::int as priced
       from public.show_finds where session_id = $1::uuid`,
      [sessionId],
    ))!;
    return {
      finds: r.finds,
      spentCents: r.spent,
      marketCents: r.market,
      edgeCents: r.priced > 0 ? r.edge : null,
      pricedFinds: r.priced,
    };
  });
}

export async function recordFind(
  userId: string,
  input: {
    sessionId: string;
    cardId: string;
    variant: Variant;
    paidCents?: number | null;
    condition?: Condition;
  },
) {
  return withIdentity(userId, async (tx) =>
    (await tx.one<{ find_id: string; market_cents: number | null; set_id: string; first_copy: boolean }>(
      'select * from public.record_find($1::uuid, $2, $3, $4, $5)',
      [input.sessionId, input.cardId, input.variant, input.paidCents ?? null, input.condition ?? 'NM'],
    ))!,
  );
}

export async function endSession(userId: string, sessionId: string): Promise<SessionSummary> {
  const summary = await sessionSummary(userId, sessionId);
  await withIdentity(userId, async (tx) => {
    await tx.exec(
      'update public.show_sessions set ended_at = now() where id = $1::uuid and ended_at is null',
      [sessionId],
    );
    await tx.exec(
      `insert into public.collection_events (user_id, type, payload)
       values ($1::uuid, 'show_ended', $2::jsonb)`,
      [userId, JSON.stringify({ sessionId, ...summary })],
    );
  });
  return summary;
}

export async function listSessions(userId: string, limit = 10) {
  return withIdentity(userId, (tx) =>
    tx.rows<{
      id: string; name: string; started_at: string; finds: number;
      spent_cents: number; edge_cents: number | null;
    }>(
      `select s.id, s.name, s.started_at::text,
              count(f.id)::int as finds,
              coalesce(sum(f.paid_cents), 0)::bigint as spent_cents,
              case when count(f.id) filter (where f.paid_cents is not null and f.market_cents is not null) > 0
                   then coalesce(sum(f.market_cents - f.paid_cents)
                        filter (where f.paid_cents is not null and f.market_cents is not null), 0)::bigint
              end as edge_cents
       from public.show_sessions s
       left join public.show_finds f on f.session_id = s.id
       group by s.id
       having count(f.id) > 0
       order by s.started_at desc
       limit $1`,
      [limit],
    ),
  );
}

/** Durable replay guard — see migration 0006. Returns true when the key is new. */
export async function claimIdempotencyKey(userId: string, key: string): Promise<boolean> {
  return withIdentity(userId, async (tx) => {
    const r = await tx.one<{ claim_idempotency_key: boolean }>(
      'select public.claim_idempotency_key($1)',
      [key],
    );
    return r?.claim_idempotency_key === true;
  });
}
