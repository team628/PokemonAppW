import { newId, nowIso, type DB } from '../db';
import type { Variant } from '../catalog/variants';
import { addToCollection } from './collection';
import { logEvent, type MilestoneRow } from './goals';

export interface ShowSession {
  id: string;
  user_id: string;
  name: string;
  venue: string | null;
  started_at: string;
  ended_at: string | null;
  budget_cents: number | null;
}

export function startSession(
  db: DB,
  userId: string,
  input: { name?: string; venue?: string | null; budgetCents?: number | null },
): ShowSession {
  const session: ShowSession = {
    id: newId('show'),
    user_id: userId,
    name: input.name?.trim() || defaultName(),
    venue: input.venue ?? null,
    started_at: nowIso(),
    ended_at: null,
    budget_cents: input.budgetCents ?? null,
  };
  db.prepare(
    'INSERT INTO show_sessions (id, user_id, name, venue, started_at, budget_cents) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(session.id, userId, session.name, session.venue, session.started_at, session.budget_cents);
  logEvent(db, userId, 'show_started', { payload: { sessionId: session.id, name: session.name } });
  return session;
}

function defaultName(): string {
  return `Hunt · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

export function activeSession(db: DB, userId: string): ShowSession | undefined {
  return db
    .prepare(
      'SELECT * FROM show_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
    )
    .get(userId) as ShowSession | undefined;
}

export function endSession(db: DB, userId: string, sessionId: string): void {
  db.prepare('UPDATE show_sessions SET ended_at = ? WHERE id = ? AND user_id = ?').run(
    nowIso(), sessionId, userId,
  );
  const s = sessionSummary(db, userId, sessionId);
  logEvent(db, userId, 'show_ended', { payload: { sessionId, ...s } });
}

export interface FindInput {
  sessionId: string;
  cardId: string;
  variant: Variant;
  paidCents?: number | null;
  condition?: 'NM' | 'LP' | 'MP' | 'HP' | 'DMG';
}

export interface FindResult {
  findId: string;
  setId: string;
  marketCents: number | null;
  milestones: MilestoneRow[];
  firstCopy: boolean;
}

/**
 * A FOUND IT tap.
 *
 * Records the market value at the moment of the find alongside what was paid,
 * because "I picked this up for $4 when it was booking at $19" is the story a
 * collector wants back later — and a price looked up next month cannot tell it.
 */
export function recordFind(db: DB, userId: string, input: FindInput): FindResult {
  const owns = db
    .prepare('SELECT 1 FROM show_sessions WHERE id = ? AND user_id = ?')
    .get(input.sessionId, userId);
  if (!owns) throw new Error('That hunt session does not belong to you.');

  const priceRow = db
    .prepare(
      `SELECT COALESCE(market_cents, mid_cents, low_cents) AS cents FROM prices
       WHERE card_id = ? AND variant = ? AND provider = 'tcgplayer'`,
    )
    .get(input.cardId, input.variant) as { cents: number | null } | undefined;
  const marketCents = priceRow?.cents ?? null;

  const added = addToCollection(db, userId, {
    cardId: input.cardId,
    variant: input.variant,
    condition: input.condition ?? 'NM',
    quantity: 1,
    paidCents: input.paidCents ?? null,
    acquiredOn: new Date().toISOString().slice(0, 10),
    sourceNote: 'Card Show mode',
  });

  const findId = newId('find');
  db.prepare(
    'INSERT INTO show_finds (id, session_id, card_id, variant, paid_cents, market_cents, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(findId, input.sessionId, input.cardId, input.variant, input.paidCents ?? null, marketCents, nowIso());

  return { findId, setId: added.setId, marketCents, milestones: added.milestones, firstCopy: added.firstCopy };
}

export interface SessionSummary {
  finds: number;
  spentCents: number;
  marketCents: number;
  /** Market value of finds minus what was paid, on finds where both are known. */
  edgeCents: number | null;
  pricedFinds: number;
}

export function sessionSummary(db: DB, userId: string, sessionId: string): SessionSummary {
  const rows = db
    .prepare(
      `SELECT f.paid_cents, f.market_cents FROM show_finds f
       JOIN show_sessions s ON s.id = f.session_id
       WHERE f.session_id = ? AND s.user_id = ?`,
    )
    .all(sessionId, userId) as { paid_cents: number | null; market_cents: number | null }[];

  let spent = 0, market = 0, edge = 0, pricedFinds = 0;
  for (const r of rows) {
    if (r.paid_cents !== null) spent += r.paid_cents;
    if (r.market_cents !== null) {
      market += r.market_cents;
      if (r.paid_cents !== null) { edge += r.market_cents - r.paid_cents; pricedFinds++; }
    }
  }
  return {
    finds: rows.length,
    spentCents: spent,
    marketCents: market,
    edgeCents: pricedFinds > 0 ? edge : null,
    pricedFinds,
  };
}

export function listSessions(db: DB, userId: string, limit = 20): (ShowSession & SessionSummary)[] {
  const sessions = db
    .prepare('SELECT * FROM show_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?')
    .all(userId, limit) as ShowSession[];
  return sessions.map((s) => ({ ...s, ...sessionSummary(db, userId, s.id) }));
}
