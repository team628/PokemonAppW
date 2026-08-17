import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '@/lib/db';
import { createUser, authenticate, createSession, userForToken, hashPassword, verifyPassword } from '@/lib/auth';
import { addToCollection, removeFromCollection, listHoldings, portfolioSummary, updateItem } from '@/lib/services/collection';
import { addGoal, metricsForSet, unseenMilestones, markMilestonesSeen, goalViews } from '@/lib/services/goals';
import { buildInsights, duplicates, tradeMatches } from '@/lib/services/insights';
import { demandForSpares, demandReport } from '@/lib/services/demand';
import { refreshWantIndex } from '@/lib/services/wantIndexRefresh';
import { startSession, recordFind, sessionSummary, endSession } from '@/lib/services/show';

/**
 * Service-layer tests against a real SQLite database with the production
 * schema, exercising the paths the app actually calls.
 */

let dir: string;
let db: DB;

/** A three-card set: two commons (with reverse holos) and one holo rare. */
function seedCatalog(db: DB) {
  db.prepare(
    `INSERT INTO sets (id, name, series, printed_total, total, release_date)
     VALUES ('tst', 'Test Set', 'Testing', 3, 4, '2023/01/01')`,
  ).run();

  const cards = [
    { id: 'tst-1', n: '1', name: 'Bulbafake', rarity: 'Common', secret: 0 },
    { id: 'tst-2', n: '2', name: 'Charfake', rarity: 'Common', secret: 0 },
    { id: 'tst-3', n: '3', name: 'Squirtfake', rarity: 'Rare Holo', secret: 0 },
    { id: 'tst-4', n: '4', name: 'Secretfake', rarity: 'Rare Secret', secret: 1 },
  ];
  for (const c of cards) {
    db.prepare(
      `INSERT INTO cards (id, set_id, number, number_sort, number_suffix, name, rarity, is_secret, subtypes, types, national_dex)
       VALUES (?, 'tst', ?, ?, '', ?, ?, ?, '[]', '[]', '[]')`,
    ).run(c.id, c.n, Number(c.n), c.name, c.rarity, c.secret);
  }

  const variants: [string, string, number][] = [
    ['tst-1', 'normal', 1], ['tst-1', 'reverseHolofoil', 0],
    ['tst-2', 'normal', 1], ['tst-2', 'reverseHolofoil', 0],
    ['tst-3', 'holofoil', 1],
    ['tst-4', 'holofoil', 1],
  ];
  for (const [card, variant, primary] of variants) {
    db.prepare(
      "INSERT INTO card_variants (card_id, variant, source, is_primary) VALUES (?, ?, 'market_data', ?)",
    ).run(card, variant, primary);
  }

  const prices: [string, string, number][] = [
    ['tst-1', 'normal', 100], ['tst-1', 'reverseHolofoil', 250],
    ['tst-2', 'normal', 200], ['tst-2', 'reverseHolofoil', 400],
    ['tst-3', 'holofoil', 5000],
    ['tst-4', 'holofoil', 20000],
  ];
  for (const [card, variant, cents] of prices) {
    db.prepare(
      `INSERT INTO prices (card_id, variant, provider, currency, low_cents, mid_cents, market_cents, observed_on, fetched_at)
       VALUES (?, ?, 'tcgplayer', 'USD', ?, ?, ?, '2026-08-17', '2026-08-17T00:00:00Z')`,
    ).run(card, variant, Math.round(cents * 0.8), cents, cents);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'setvalue-'));
  db = openDb(path.join(dir, 'test.db'));
  seedCatalog(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const newUser = (email = 'ash@example.com') =>
  createUser(db, { email, password: 'pallet-town-1', displayName: 'Ash' });

describe('auth', () => {
  it('hashes passwords so the plaintext never appears in storage', () => {
    const hash = hashPassword('pallet-town-1');
    expect(hash).not.toContain('pallet-town-1');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('pallet-town-1', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces a different hash for the same password each time', () => {
    expect(hashPassword('same-password')).not.toBe(hashPassword('same-password'));
  });

  it('authenticates a real user and rejects a bad password', () => {
    newUser();
    expect(authenticate(db, 'ash@example.com', 'pallet-town-1')).not.toBeNull();
    expect(authenticate(db, 'ash@example.com', 'nope')).toBeNull();
    expect(authenticate(db, 'nobody@example.com', 'pallet-town-1')).toBeNull();
  });

  it('rejects duplicate emails and weak passwords', () => {
    newUser();
    expect(() => newUser()).toThrow(/already exists/i);
    expect(() => createUser(db, { email: 'b@example.com', password: 'short', displayName: 'B' })).toThrow(/8 characters/);
    expect(() => createUser(db, { email: 'not-an-email', password: 'longenough', displayName: 'B' })).toThrow(/valid email/);
  });

  it('resolves a session token but never stores it in the clear', () => {
    const user = newUser();
    const { token } = createSession(db, user.id);
    expect(userForToken(db, token)?.id).toBe(user.id);
    expect(userForToken(db, 'forged-token')).toBeNull();
    const stored = db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
    expect(stored.token_hash).not.toBe(token);
  });

  it('gives every user a distinct public handle', () => {
    const a = newUser('a@example.com');
    const b = createUser(db, { email: 'b@example.com', password: 'password123', displayName: 'Ash' });
    expect(a.handle).not.toBe(b.handle);
  });
});

describe('collection and completion', () => {
  it('computes each goal mode over the right slots', () => {
    const user = newUser();
    expect(metricsForSet(db, user.id, 'tst', 'main').requiredCount).toBe(3);
    expect(metricsForSet(db, user.id, 'tst', 'complete').requiredCount).toBe(4);
    expect(metricsForSet(db, user.id, 'tst', 'master').requiredCount).toBe(6);
  });

  it('moves a card from NEED to HAVE and keeps the totals reconciling', () => {
    const user = newUser();
    const before = metricsForSet(db, user.id, 'tst', 'main');
    expect(before.haveCents).toBe(0);
    expect(before.needCents).toBe(5300);

    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil' });

    const after = metricsForSet(db, user.id, 'tst', 'main');
    expect(after.haveCents).toBe(5000);
    expect(after.needCents).toBe(300);
    expect(after.completeCents).toBe(before.completeCents);
    expect(after.haveCents + after.needCents).toBe(after.completeCents);
    expect(after.ownedCount).toBe(1);
  });

  it('does not let a reverse holo satisfy a main-set slot', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'reverseHolofoil' });
    expect(metricsForSet(db, user.id, 'tst', 'main').ownedCount).toBe(0);
    expect(metricsForSet(db, user.id, 'tst', 'master').ownedCount).toBe(1);
  });

  it('stacks copies and returns them on removal', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    const second = addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    expect(second.quantity).toBe(2);
    expect(second.firstCopy).toBe(false);

    removeFromCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    expect(metricsForSet(db, user.id, 'tst', 'main').ownedCount).toBe(1);

    removeFromCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    expect(metricsForSet(db, user.id, 'tst', 'main').ownedCount).toBe(0);
  });

  it('keeps different conditions as separate holdings and prices them apart', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil', condition: 'NM' });
    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil', condition: 'HP' });

    const holdings = listHoldings(db, user.id);
    expect(holdings).toHaveLength(2);
    const nm = holdings.find((h) => h.condition === 'NM')!;
    const hp = holdings.find((h) => h.condition === 'HP')!;
    expect(nm.unitValueCents).toBe(5000);
    expect(hp.unitValueCents).toBe(2500); // 50% band for Heavily Played
    expect(hp.conditionAdjusted).toBe(true);
  });

  it('summarises a portfolio including cost basis and duplicates', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil', paidCents: 3000 });
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal', quantity: 3 });

    const s = portfolioSummary(db, user.id);
    expect(s.totalCards).toBe(4);
    expect(s.uniqueCards).toBe(2);
    expect(s.valueCents).toBe(5000 + 300);
    expect(s.costBasisCents).toBe(3000);
    expect(s.gainCents).toBe(2000);
    expect(s.duplicateCopies).toBe(2);
    expect(s.duplicateValueCents).toBe(200);
  });

  it('deletes a holding when its quantity is edited to zero', () => {
    const user = newUser();
    const { itemId } = addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal', quantity: 2 });
    updateItem(db, user.id, itemId, { quantity: 0 });
    expect(listHoldings(db, user.id)).toHaveLength(0);
  });
});

describe('milestones', () => {
  it('fires each milestone once and never re-fires it', () => {
    const user = newUser();
    addGoal(db, user.id, 'tst', 'main');

    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, user.id, { cardId: 'tst-2', variant: 'normal' });
    let kinds = unseenMilestones(db, user.id).map((m) => m.kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('one_left');
    markMilestonesSeen(db, user.id);

    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil' });
    kinds = unseenMilestones(db, user.id).map((m) => m.kind);
    expect(kinds).toContain('complete');

    // Sell a card and re-acquire it: the moment already happened.
    markMilestonesSeen(db, user.id);
    removeFromCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil' });
    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil' });
    expect(unseenMilestones(db, user.id)).toHaveLength(0);

    const completeRows = db
      .prepare("SELECT COUNT(*) AS n FROM milestones WHERE user_id = ? AND kind = 'complete'")
      .get(user.id) as { n: number };
    expect(completeRows.n).toBe(1);
  });

  it('stamps the goal as completed when the last card lands', () => {
    const user = newUser();
    const goal = addGoal(db, user.id, 'tst', 'main');
    for (const [card, variant] of [['tst-1', 'normal'], ['tst-2', 'normal'], ['tst-3', 'holofoil']] as const) {
      addToCollection(db, user.id, { cardId: card, variant });
    }
    const row = db.prepare('SELECT completed_at FROM set_goals WHERE id = ?').get(goal.id) as { completed_at: string | null };
    expect(row.completed_at).not.toBeNull();
  });

  it('writes a journey event for every acquisition', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    const events = db
      .prepare('SELECT type FROM events WHERE user_id = ? ORDER BY created_at')
      .all(user.id) as { type: string }[];
    expect(events.map((e) => e.type)).toContain('card_acquired');
    expect(events.map((e) => e.type)).toContain('copy_added');
  });
});

describe('insights', () => {
  it('recommends a finish-line move when a set is nearly done', () => {
    const user = newUser();
    addGoal(db, user.id, 'tst', 'main');
    addToCollection(db, user.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, user.id, { cardId: 'tst-2', variant: 'normal' });

    const { moves } = buildInsights(db, user.id);
    expect(moves[0]!.kind).toBe('finish_line');
    expect(moves[0]!.evidence[0]!.cardId).toBe('tst-3');
  });

  it('reports no price movement while only one snapshot exists', () => {
    const user = newUser();
    addGoal(db, user.id, 'tst', 'main');
    const insights = buildInsights(db, user.id);
    expect(insights.drops).toHaveLength(0);
    expect(insights.historyTooShallow).toBe(true);
  });

  it('detects a real drop once two dated observations exist', () => {
    const user = newUser();
    addGoal(db, user.id, 'tst', 'main');
    db.prepare(
      `INSERT INTO price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
       VALUES ('tst-3', 'holofoil', 'tcgplayer', '2026-08-10', 9000, 8000),
              ('tst-3', 'holofoil', 'tcgplayer', '2026-08-17', 5000, 4000)`,
    ).run();

    const insights = buildInsights(db, user.id);
    expect(insights.historyTooShallow).toBe(false);
    const drop = insights.drops.find((d) => d.cardId === 'tst-3');
    expect(drop).toBeDefined();
    expect(drop!.previousCents).toBe(9000);
    expect(drop!.currentCents).toBe(5000);
    expect(insights.moves.some((m) => m.kind === 'price_drop')).toBe(true);
  });

  it('lists duplicates with their spare count and value', () => {
    const user = newUser();
    addToCollection(db, user.id, { cardId: 'tst-3', variant: 'holofoil', quantity: 3 });
    const [dupe] = duplicates(db, user.id);
    expect(dupe!.spareCopies).toBe(2);
    expect(dupe!.unitValueCents).toBe(5000);
  });
});

describe('trade matching', () => {
  it('matches another collector’s spare against a hole in my set, both ways', () => {
    const me = newUser('me@example.com');
    const them = createUser(db, { email: 'them@example.com', password: 'password123', displayName: 'Misty' });

    addGoal(db, me.id, 'tst', 'main');
    addGoal(db, them.id, 'tst', 'main');

    // I hold spare copies of card 1; they hold spare copies of card 3.
    addToCollection(db, me.id, { cardId: 'tst-1', variant: 'normal', quantity: 2 });
    const theirs = addToCollection(db, them.id, { cardId: 'tst-3', variant: 'holofoil', quantity: 2 });
    db.prepare('UPDATE collection_items SET for_trade = 1 WHERE id = ?').run(theirs.itemId);

    const matches = tradeMatches(db, me.id, goalViews(db, me.id));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.cardId).toBe('tst-3');
    expect(matches[0]!.counterpartHandle).toBe(them.handle);
    expect(matches[0]!.mutual).toBe(true);
  });

  it('does not surface cards that were never marked for trade', () => {
    const me = newUser('me@example.com');
    const them = createUser(db, { email: 'them@example.com', password: 'password123', displayName: 'Misty' });
    addGoal(db, me.id, 'tst', 'main');
    addToCollection(db, them.id, { cardId: 'tst-3', variant: 'holofoil', quantity: 2 });
    expect(tradeMatches(db, me.id, goalViews(db, me.id))).toHaveLength(0);
  });

  it('counts demand for my spares without naming anybody', () => {
    const me = newUser('me@example.com');
    const a = createUser(db, { email: 'a@example.com', password: 'password123', displayName: 'A' });
    const b = createUser(db, { email: 'b@example.com', password: 'password123', displayName: 'B' });
    addGoal(db, a.id, 'tst', 'main');
    addGoal(db, b.id, 'tst', 'main');
    addToCollection(db, me.id, { cardId: 'tst-3', variant: 'holofoil', quantity: 2 });

    const [spare] = demandForSpares(db, me.id);
    expect(spare!.wantedBy).toBe(2);
    expect(Object.keys(spare!)).not.toContain('userId');
  });

  it('aggregates a partner demand report as counts only', () => {
    const a = createUser(db, { email: 'a@example.com', password: 'password123', displayName: 'A' });
    const b = createUser(db, { email: 'b@example.com', password: 'password123', displayName: 'B' });
    addGoal(db, a.id, 'tst', 'main');
    addGoal(db, b.id, 'tst', 'main');
    addToCollection(db, a.id, { cardId: 'tst-3', variant: 'holofoil' });

    refreshWantIndex(db);
    const report = demandReport(db, { limit: 10 }).rows;
    const holo = report.find((r) => r.cardId === 'tst-3')!;
    expect(holo.collectors).toBe(1); // only B still needs it
    const common = report.find((r) => r.cardId === 'tst-1')!;
    expect(common.collectors).toBe(2);
    expect(JSON.stringify(report)).not.toContain(a.id);
  });
});

describe('card show mode', () => {
  it('records a find, adds the card, and reports the running edge', () => {
    const user = newUser();
    addGoal(db, user.id, 'tst', 'main');
    const session = startSession(db, user.id, { name: 'Saturday show' });

    const find = recordFind(db, user.id, {
      sessionId: session.id, cardId: 'tst-3', variant: 'holofoil', paidCents: 3000,
    });
    expect(find.marketCents).toBe(5000);
    expect(find.firstCopy).toBe(true);

    const summary = sessionSummary(db, user.id, session.id);
    expect(summary.finds).toBe(1);
    expect(summary.spentCents).toBe(3000);
    expect(summary.marketCents).toBe(5000);
    expect(summary.edgeCents).toBe(2000);

    expect(metricsForSet(db, user.id, 'tst', 'main').ownedCount).toBe(1);
  });

  it('leaves edge undefined when no price was logged', () => {
    const user = newUser();
    const session = startSession(db, user.id, {});
    recordFind(db, user.id, { sessionId: session.id, cardId: 'tst-1', variant: 'normal' });
    expect(sessionSummary(db, user.id, session.id).edgeCents).toBeNull();
  });

  it('refuses to write finds into someone else’s session', () => {
    const me = newUser('me@example.com');
    const them = createUser(db, { email: 'them@example.com', password: 'password123', displayName: 'Misty' });
    const session = startSession(db, them.id, {});
    expect(() =>
      recordFind(db, me.id, { sessionId: session.id, cardId: 'tst-1', variant: 'normal' }),
    ).toThrow(/does not belong to you/);
  });

  it('logs the hunt to the journey when it ends', () => {
    const user = newUser();
    const session = startSession(db, user.id, {});
    recordFind(db, user.id, { sessionId: session.id, cardId: 'tst-1', variant: 'normal', paidCents: 50 });
    endSession(db, user.id, session.id);
    const ended = db
      .prepare("SELECT payload FROM events WHERE user_id = ? AND type = 'show_ended'")
      .get(user.id) as { payload: string };
    expect(JSON.parse(ended.payload).finds).toBe(1);
  });
});
