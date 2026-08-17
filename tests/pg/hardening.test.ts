import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { addToCollection, listHoldingsPage, portfolioSummary } from '@/lib/services/pg/collection';
import { addGoal, goalMetrics, syncMilestonesForSet, unseenMilestones, consumeRateLimit, RULES } from '@/lib/services/pg';
import { claimIdempotencyKey } from '@/lib/services/pg/show';
import { myProfile } from '@/lib/services/pg/profile';
import { seedSet, seedUser, dropUsers, type Fixture } from './fixtures';

/**
 * Regression tests for the issues found by the adversarial pass — graded cards
 * valued at raw prices, unbounded page payloads, a memory-only replay guard, no
 * rate limiting — re-asserted against PostgreSQL.
 *
 * The durability tests are stronger here than they were on SQLite: "survives a
 * restart" was previously demonstrated by reopening a file in the same process.
 * These claim a key or spend a budget through one pool, drop the pool entirely,
 * and re-check through a fresh connection — which is the actual serverless
 * failure mode, where every request may land on a different instance.
 */

let fx: Fixture;
let a = '';
let b = '';

beforeAll(async () => {
  fx = await seedSet();
  [a, b] = await Promise.all([seedUser('hard-a'), seedUser('hard-b')]);
});

afterAll(async () => {
  await dropUsers(a, b);
  await fx.cleanup();
  await closePool();
});

async function reset() {
  await withServiceRole(async (tx) => {
    for (const id of [a, b]) {
      await tx.exec('delete from public.collection_items where user_id = $1::uuid', [id]);
      await tx.exec('delete from public.set_goals where user_id = $1::uuid', [id]);
      await tx.exec('delete from public.idempotency_keys where user_id = $1::uuid', [id]);
    }
  });
}

const card = (n: number) => `${fx.setId}-${n}`;

describe('privacy', () => {
  it('creates collections private by default', async () => {
    const profile = await myProfile(a);
    expect(profile!.share_public).toBe(false);
    // Not merely the app default — the column default itself, which is what a
    // direct insert or a future code path would land on.
    const dflt = await withServiceRole(async (tx) =>
      (await tx.one<{ d: string | null }>(
        `select column_default as d from information_schema.columns
         where table_schema = 'public' and table_name = 'profiles' and column_name = 'share_public'`,
      ))!.d,
    );
    expect(dflt).toBe('false');
  });
});

describe('graded cards are held but not valued', () => {
  it('refuses to price a slabbed card at the raw price', async () => {
    await reset();
    await addToCollection(a, {
      cardId: card(1), variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const h = (await listHoldingsPage(a)).rows[0]!;
    expect(h.isGraded).toBe(true);
    expect(h.estimatedValueCents).toBeNull();
    expect(h.observedMarketCents).toBeNull();
    expect(h.unvaluedReason).toBe('graded');
  });

  it('still values the raw copy of the same card', async () => {
    await reset();
    await addToCollection(a, { cardId: card(1), variant: 'normal' });
    await addToCollection(a, {
      cardId: card(1), variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const rows = (await listHoldingsPage(a)).rows;
    expect(rows.find((h) => !h.isGraded)!.estimatedValueCents).toBe(100);
    expect(rows.find((h) => h.isGraded)!.estimatedValueCents).toBeNull();
  });

  it('excludes graded cards from portfolio value and counts them separately', async () => {
    await reset();
    await addToCollection(a, { cardId: card(1), variant: 'normal' });
    await addToCollection(a, {
      cardId: card(2), variant: 'normal', gradeCompany: 'PSA', gradeValue: '10', quantity: 2,
    });
    const s = await portfolioSummary(a);
    expect(s.totalCards).toBe(3);
    expect(s.gradedCards).toBe(2);
    expect(s.estimatedValueCents).toBe(100); // only the raw card
    expect(s.observedValueCents).toBe(100);
    expect(s.pricedCards).toBe(1);
  });

  it('still counts a graded card toward set completion', async () => {
    await reset();
    await addGoal(a, fx.setId, 'main');
    await addToCollection(a, {
      cardId: card(1), variant: 'normal', gradeCompany: 'BGS', gradeValue: '9.5',
    });
    const m = await goalMetrics(a, fx.setId, 'main');
    expect(m.owned_count).toBe(1);
    expect(m.missing_count).toBe(2);
  });
});

describe('collection paging', () => {
  it('returns a bounded page while totalling the whole filtered set', async () => {
    await reset();
    for (const [n, v] of [[1, 'normal'], [2, 'normal'], [3, 'holofoil']] as const) {
      await addToCollection(a, { cardId: card(n), variant: v });
    }

    const page = await listHoldingsPage(a, { pageSize: 10 });
    expect(page.rows).toHaveLength(3);
    expect(page.total).toBe(3);
    expect(page.estimatedValueCents).toBe(100 + 200 + 5000);

    const first = await listHoldingsPage(a, { pageSize: 10, page: 1 });
    expect(first.pageSize).toBe(10);
    // Totals describe everything matched, not just the page.
    expect(first.estimatedValueCents).toBe(5300);
  });

  it('clamps page size and page number rather than trusting the caller', async () => {
    await reset();
    await addToCollection(a, { cardId: card(1), variant: 'normal' });
    expect((await listHoldingsPage(a, { pageSize: 100_000 })).pageSize).toBe(200);
    expect((await listHoldingsPage(a, { pageSize: 1 })).pageSize).toBe(10);
    expect((await listHoldingsPage(a, { page: 999 })).page).toBe(1);
    expect((await listHoldingsPage(a, { page: -5 })).page).toBe(1);
  });

  it('filters to graded holdings and excludes them from the value total', async () => {
    await reset();
    await addToCollection(a, { cardId: card(1), variant: 'normal' });
    await addToCollection(a, {
      cardId: card(2), variant: 'normal', gradeCompany: 'PSA', gradeValue: '10',
    });
    const graded = await listHoldingsPage(a, { view: 'graded' });
    expect(graded.total).toBe(1);
    expect(graded.estimatedValueCents).toBe(0);
    expect(graded.gradedCards).toBe(1);
  });

  it('searches by card name without loading the whole collection', async () => {
    await reset();
    for (const [n, v] of [[1, 'normal'], [2, 'normal'], [3, 'holofoil']] as const) {
      await addToCollection(a, { cardId: card(n), variant: v });
    }
    const hit = await listHoldingsPage(a, { q: 'Charfake' });
    expect(hit.total).toBe(1);
    expect(hit.rows[0]!.name).toBe('Charfake');
  });
});

describe('idempotency is durable', () => {
  it('accepts a key once and rejects the replay', async () => {
    await reset();
    const key = randomUUID();
    expect(await claimIdempotencyKey(a, key)).toBe(true);
    expect(await claimIdempotencyKey(a, key)).toBe(false);
  });

  it('scopes keys per user', async () => {
    await reset();
    const key = randomUUID();
    expect(await claimIdempotencyKey(a, key)).toBe(true);
    expect(await claimIdempotencyKey(b, key)).toBe(true);
  });

  it('holds across a dropped connection pool, not just within one process', async () => {
    await reset();
    const key = randomUUID();
    expect(await claimIdempotencyKey(a, key)).toBe(true);
    await closePool();
    expect(await claimIdempotencyKey(a, key)).toBe(false);
  });

  it('sweeps only keys past the retention window', async () => {
    await reset();
    const fresh = randomUUID();
    await claimIdempotencyKey(a, fresh);
    await withServiceRole((tx) =>
      tx.exec(
        `insert into public.idempotency_keys (user_id, key, created_at)
         values ($1::uuid, 'ancient', now() - interval '30 days')`,
        [a],
      ),
    );
    await withServiceRole((tx) => tx.exec("select public.sweep_idempotency_keys('1 hour')"));

    const keys = await withIdentity(a, async (tx) =>
      (await tx.rows<{ key: string }>('select key from public.idempotency_keys')).map((r) => r.key),
    );
    expect(keys).toContain(fresh);
    expect(keys).not.toContain('ancient');
  });
});

describe('rate limiting', () => {
  it('allows up to the limit and then refuses', async () => {
    const bucket = `t-${randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(bucket, 3, 60)).allowed).toBe(true);
    }
    const blocked = await consumeRateLimit(bucket, 3, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
  });

  it('keeps buckets independent', async () => {
    const x = `x-${randomUUID()}`;
    const y = `y-${randomUUID()}`;
    expect((await consumeRateLimit(x, 1, 60)).allowed).toBe(true);
    expect((await consumeRateLimit(y, 1, 60)).allowed).toBe(true);
    expect((await consumeRateLimit(x, 1, 60)).allowed).toBe(false);
  });

  it('holds across a dropped connection pool rather than handing out a fresh budget', async () => {
    const bucket = `p-${randomUUID()}`;
    await consumeRateLimit(bucket, 2, 300);
    await consumeRateLimit(bucket, 2, 300);
    await closePool();
    expect((await consumeRateLimit(bucket, 2, 300)).allowed).toBe(false);
  });

  it('holds under concurrent callers rather than letting them race past it', async () => {
    // Twenty simultaneous requests against a budget of five. A read-then-write
    // limiter would let most of them through; the counter is incremented and
    // read in one statement, so exactly five are allowed.
    const bucket = `c-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(bucket, 5, 300)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('ships sane defaults for the endpoints that matter', () => {
    expect(RULES.signIn.limit).toBeLessThanOrEqual(10);
    expect(RULES.signUp.limit).toBeLessThanOrEqual(10);
    expect(RULES.publicPage.limit).toBeGreaterThan(0);
  });

  it('does not let a caller read or reset its own budget', async () => {
    // The table is deliberately unreadable: a caller can spend budget through
    // the SECURITY DEFINER function but cannot inspect or clear it.
    await expect(
      withIdentity(a, (tx) => tx.rows('select * from public.rate_limits')),
    ).rejects.toThrow();
  });
});

describe('bulk import defers milestones', () => {
  it('does not fire a milestone per row, and fires them on the sweep', async () => {
    await reset();
    await addGoal(a, fx.setId, 'main');
    // add_to_collection does no milestone work at all — the sweep is the only
    // thing that fires them, so a 5,000-row import cannot recompute per row.
    for (const [n, v] of [[1, 'normal'], [2, 'normal'], [3, 'holofoil']] as const) {
      await addToCollection(a, { cardId: card(n), variant: v });
    }
    expect(await unseenMilestones(a)).toHaveLength(0);

    const fired = await syncMilestonesForSet(a, fx.setId);
    expect(fired).toContain('complete');
  });
});
