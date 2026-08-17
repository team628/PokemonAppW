import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '@/lib/db';
import { createUser } from '@/lib/auth';
import {
  addToCollection,
  listHoldings,
  listHoldingsPage,
  portfolioSummary,
} from '@/lib/services/collection';
import { addGoal, metricsForSet, unseenMilestones, syncMilestonesForSet } from '@/lib/services/goals';
import { claimKey, sweepKeys } from '@/lib/services/idempotency';
import { checkLimit, RULES } from '@/lib/rateLimit';

/**
 * Regression tests for the issues found by the adversarial pass: graded cards
 * being valued at raw prices, unbounded page payloads, a memory-only replay
 * guard, no rate limiting, and per-row milestone recomputation during import.
 */

let dir: string;
let db: DB;

function seedCatalog(db: DB) {
  db.prepare(
    `INSERT INTO sets (id,name,series,printed_total,total,release_date)
     VALUES ('tst','Test Set','Testing',3,3,'2023/01/01')`,
  ).run();
  for (const [id, n, name] of [['tst-1', '1', 'Alpha'], ['tst-2', '2', 'Beta'], ['tst-3', '3', 'Gamma']] as const) {
    db.prepare(
      `INSERT INTO cards (id,set_id,number,number_sort,number_suffix,name,rarity,is_secret,subtypes,types,national_dex)
       VALUES (?,'tst',?,?,'',?,'Common',0,'[]','[]','[]')`,
    ).run(id, n, Number(n), name);
    db.prepare(
      "INSERT INTO card_variants (card_id,variant,source,is_primary) VALUES (?,'normal','market_data',1)",
    ).run(id);
    db.prepare(
      `INSERT INTO prices (card_id,variant,provider,currency,low_cents,mid_cents,market_cents,observed_on,fetched_at)
       VALUES (?,'normal','tcgplayer','USD',800,1000,1000,'2026-08-17','2026-08-17T00:00:00Z')`,
    ).run(id);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'harden-'));
  db = openDb(path.join(dir, 'test.db'));
  seedCatalog(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const user = () => createUser(db, { email: 'a@example.test', password: 'password123', displayName: 'A' });

describe('privacy', () => {
  it('creates collections private by default', () => {
    expect(user().share_public).toBe(0);
    const row = db.prepare('SELECT share_public FROM users').get() as { share_public: number };
    expect(row.share_public).toBe(0);
  });
});

describe('graded cards are held but not valued', () => {
  it('refuses to price a slabbed card at the raw price', () => {
    const u = user();
    addToCollection(db, u.id, {
      cardId: 'tst-1', variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const h = listHoldings(db, u.id)[0]!;
    expect(h.isGraded).toBe(true);
    expect(h.valueCents).toBeNull();
    expect(h.unitValueCents).toBeNull();
    expect(h.unvaluedReason).toBe('graded');
  });

  it('still values the raw copy of the same card', () => {
    const u = user();
    addToCollection(db, u.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, u.id, {
      cardId: 'tst-1', variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const holdings = listHoldings(db, u.id);
    const raw = holdings.find((h) => !h.isGraded)!;
    const slab = holdings.find((h) => h.isGraded)!;
    expect(raw.valueCents).toBe(1000);
    expect(slab.valueCents).toBeNull();
  });

  it('excludes graded cards from portfolio value and counts them separately', () => {
    const u = user();
    addToCollection(db, u.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, u.id, {
      cardId: 'tst-2', variant: 'normal', gradeCompany: 'PSA', gradeValue: '10', quantity: 2,
    });
    const s = portfolioSummary(db, u.id);
    expect(s.totalCards).toBe(3);
    expect(s.gradedCards).toBe(2);
    expect(s.valueCents).toBe(1000); // only the raw card
    expect(s.pricedCards).toBe(1);
  });

  it('still counts a graded card toward set completion', () => {
    const u = user();
    addGoal(db, u.id, 'tst', 'main');
    addToCollection(db, u.id, {
      cardId: 'tst-1', variant: 'normal', gradeCompany: 'BGS', gradeValue: '9.5',
    });
    const m = metricsForSet(db, u.id, 'tst', 'main');
    expect(m.ownedCount).toBe(1);
    expect(m.missingCount).toBe(2);
  });
});

describe('collection paging', () => {
  it('returns a bounded page while totalling the whole filtered set', () => {
    const u = user();
    for (const id of ['tst-1', 'tst-2', 'tst-3']) {
      addToCollection(db, u.id, { cardId: id, variant: 'normal' });
    }
    const page = listHoldingsPage(db, u.id, { pageSize: 10 });
    expect(page.rows).toHaveLength(3);
    expect(page.total).toBe(3);
    expect(page.valueCents).toBe(3000);

    const first = listHoldingsPage(db, u.id, { pageSize: 10, page: 1 });
    expect(first.pageSize).toBe(10);
    // Totals describe everything matched, not just the page.
    expect(first.valueCents).toBe(3000);
  });

  it('clamps page size and page number rather than trusting the caller', () => {
    const u = user();
    addToCollection(db, u.id, { cardId: 'tst-1', variant: 'normal' });
    expect(listHoldingsPage(db, u.id, { pageSize: 100_000 }).pageSize).toBe(200);
    expect(listHoldingsPage(db, u.id, { pageSize: 1 }).pageSize).toBe(10);
    expect(listHoldingsPage(db, u.id, { page: 999 }).page).toBe(1);
    expect(listHoldingsPage(db, u.id, { page: -5 }).page).toBe(1);
  });

  it('filters to graded holdings and excludes them from the value total', () => {
    const u = user();
    addToCollection(db, u.id, { cardId: 'tst-1', variant: 'normal' });
    addToCollection(db, u.id, {
      cardId: 'tst-2', variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const graded = listHoldingsPage(db, u.id, { view: 'graded' });
    expect(graded.total).toBe(1);
    expect(graded.valueCents).toBe(0);
    expect(graded.gradedCards).toBe(1);
  });

  it('searches by card name without loading the whole collection', () => {
    const u = user();
    for (const id of ['tst-1', 'tst-2', 'tst-3']) {
      addToCollection(db, u.id, { cardId: id, variant: 'normal' });
    }
    const hit = listHoldingsPage(db, u.id, { q: 'Beta' });
    expect(hit.total).toBe(1);
    expect(hit.rows[0]!.name).toBe('Beta');
  });
});

describe('idempotency is durable', () => {
  it('accepts a key once and rejects the replay', () => {
    const u = user();
    expect(claimKey(db, u.id, 'k1')).toBe(true);
    expect(claimKey(db, u.id, 'k1')).toBe(false);
  });

  it('scopes keys per user', () => {
    const a = user();
    const b = createUser(db, { email: 'b@example.test', password: 'password123', displayName: 'B' });
    expect(claimKey(db, a.id, 'shared')).toBe(true);
    expect(claimKey(db, b.id, 'shared')).toBe(true);
  });

  it('survives a process restart, unlike an in-memory guard', () => {
    const u = user();
    expect(claimKey(db, u.id, 'persist')).toBe(true);
    const file = path.join(dir, 'test.db');
    db.close();
    db = openDb(file);
    expect(claimKey(db, u.id, 'persist')).toBe(false);
  });

  it('sweeps only keys past the retention window', () => {
    const u = user();
    claimKey(db, u.id, 'fresh');
    db.prepare("INSERT INTO idempotency_keys (user_id,key,created_at) VALUES (?,?,'2000-01-01T00:00:00Z')").run(u.id, 'ancient');
    sweepKeys(db, 1);
    const keys = (db.prepare('SELECT key FROM idempotency_keys').all() as { key: string }[]).map((r) => r.key);
    expect(keys).toContain('fresh');
    expect(keys).not.toContain('ancient');
  });
});

describe('rate limiting', () => {
  it('allows up to the limit and then refuses', () => {
    const rule = { limit: 3, windowSeconds: 60 };
    expect(checkLimit(db, 'b', rule).allowed).toBe(true);
    expect(checkLimit(db, 'b', rule).allowed).toBe(true);
    expect(checkLimit(db, 'b', rule).allowed).toBe(true);
    const blocked = checkLimit(db, 'b', rule);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keeps buckets independent', () => {
    const rule = { limit: 1, windowSeconds: 60 };
    expect(checkLimit(db, 'x', rule).allowed).toBe(true);
    expect(checkLimit(db, 'y', rule).allowed).toBe(true);
    expect(checkLimit(db, 'x', rule).allowed).toBe(false);
  });

  it('survives a restart rather than handing out a fresh budget', () => {
    const rule = { limit: 2, windowSeconds: 300 };
    checkLimit(db, 'persisted', rule);
    checkLimit(db, 'persisted', rule);
    const file = path.join(dir, 'test.db');
    db.close();
    db = openDb(file);
    expect(checkLimit(db, 'persisted', rule).allowed).toBe(false);
  });

  it('ships sane defaults for the endpoints that matter', () => {
    expect(RULES.signIn.limit).toBeLessThanOrEqual(10);
    expect(RULES.signUp.limit).toBeLessThanOrEqual(10);
    expect(RULES.publicPage.limit).toBeGreaterThan(0);
  });
});

describe('deferred milestones', () => {
  it('does not fire milestones per row when deferred, and fires them on the sweep', () => {
    const u = user();
    addGoal(db, u.id, 'tst', 'main');
    for (const id of ['tst-1', 'tst-2', 'tst-3']) {
      const r = addToCollection(db, u.id, { cardId: id, variant: 'normal', deferMilestones: true });
      expect(r.milestones).toEqual([]);
    }
    expect(unseenMilestones(db, u.id)).toHaveLength(0);

    const fired = syncMilestonesForSet(db, u.id, 'tst');
    expect(fired.map((m) => m.kind)).toContain('complete');
  });

  it('still fires immediately for a single interactive add', () => {
    const u = user();
    addGoal(db, u.id, 'tst', 'main');
    const r = addToCollection(db, u.id, { cardId: 'tst-1', variant: 'normal' });
    expect(r.milestones.map((m) => m.kind)).toContain('started');
  });
});
