import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import { addToCollection, removeFromCollection } from '@/lib/services/pg/collection';
import { claimIdempotencyKey, currentOrNewSession, recordFind, sessionSummary } from '@/lib/services/pg/show';
import { consumeRateLimit } from '@/lib/services/pg';
import { seedSet, seedUser, dropUsers, type Fixture } from './fixtures';

/**
 * Races.
 *
 * Every case here is two or more requests arriving at the same instant on
 * different connections — the shape a serverless deployment produces constantly
 * and a single-threaded test never sees. They are run against the real
 * connection pool rather than a mock, because what is being tested is what
 * PostgreSQL does under READ COMMITTED, not what the application intends.
 */

let fx: Fixture;
let user = '';

beforeAll(async () => {
  fx = await seedSet();
  user = await seedUser('conc');
});

afterAll(async () => {
  await dropUsers(user);
  await fx.cleanup();
  await closePool();
});

beforeEach(async () => {
  await withServiceRole(async (tx) => {
    await tx.exec('delete from public.collection_items where user_id = $1::uuid', [user]);
    await tx.exec('delete from public.collection_events where user_id = $1::uuid', [user]);
    await tx.exec('delete from public.show_sessions where user_id = $1::uuid', [user]);
  });
});

const card = (n: number) => `${fx.setId}-${n}`;

describe('concurrent adds of the same card', () => {
  it('lands on the right quantity with no lost update', async () => {
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => addToCollection(user, { cardId: card(1), variant: 'normal' })),
    );
    const quantities = results.map((r) => r.quantity).sort((a, b) => a - b);
    expect(Math.max(...quantities)).toBe(N);
    // Each caller must have observed a different intermediate quantity: two
    // callers seeing the same number would mean one increment was lost.
    expect(new Set(quantities).size).toBe(N);
  });

  it('lets exactly one caller claim the first copy', async () => {
    // This failed before migration 0011: `first_copy` came from a SELECT taken
    // before the upsert, so under READ COMMITTED every concurrent caller read
    // zero and eight of twenty claimed the acquisition.
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () => addToCollection(user, { cardId: card(1), variant: 'normal' })),
    );
    expect(results.filter((r) => r.first_copy)).toHaveLength(1);
  });

  it('writes exactly one acquisition event and the rest as extra copies', async () => {
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, () => addToCollection(user, { cardId: card(2), variant: 'normal' })),
    );
    const events = await withIdentity(user, (tx) =>
      tx.rows<{ type: string }>('select type from public.collection_events where card_id = $1', [card(2)]),
    );
    expect(events.filter((e) => e.type === 'card_acquired')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'copy_added')).toHaveLength(N - 1);
  });

  it('does not confuse a different condition for a first copy', async () => {
    // A first NM copy beside an existing LP copy is a new row but not a first
    // copy — which is why `xmax = 0` was the wrong fix for the race above.
    const first = await addToCollection(user, { cardId: card(3), variant: 'holofoil', condition: 'LP' });
    expect(first.first_copy).toBe(true);
    const second = await addToCollection(user, { cardId: card(3), variant: 'holofoil', condition: 'NM' });
    expect(second.first_copy).toBe(false);
  });

  it('does not serialise unrelated adds behind each other', async () => {
    // The lock is keyed on (collector, card, printing). Adds to four different
    // cards must all succeed rather than deadlocking or blocking.
    const results = await Promise.all([
      addToCollection(user, { cardId: card(1), variant: 'normal' }),
      addToCollection(user, { cardId: card(2), variant: 'normal' }),
      addToCollection(user, { cardId: card(3), variant: 'holofoil' }),
      addToCollection(user, { cardId: card(4), variant: 'holofoil' }),
    ]);
    expect(results.every((r) => r.first_copy)).toBe(true);
  });
});

describe('concurrent removals', () => {
  it('never drives a stack negative', async () => {
    await addToCollection(user, { cardId: card(1), variant: 'normal', quantity: 20 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        removeFromCollection(user, { cardId: card(1), variant: 'normal', quantity: 1 }),
      ),
    );
    const remaining = results.map((r) => r.remaining);
    expect(Math.min(...remaining)).toBe(0);
    expect(remaining.every((r) => r >= 0)).toBe(true);
  });

  it('removing more than is held stops at empty', async () => {
    await addToCollection(user, { cardId: card(1), variant: 'normal', quantity: 3 });
    const r = await removeFromCollection(user, { cardId: card(1), variant: 'normal', quantity: 999 });
    expect(r.remaining).toBe(0);
  });
});

describe('a replayed offline queue', () => {
  it('applies one find and reports the rest as duplicates', async () => {
    const session = await currentOrNewSession(user);
    const key = randomUUID();
    const N = 10;

    const claims = await Promise.all(
      Array.from({ length: N }, () => claimIdempotencyKey(user, key)),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);

    // Only the winning claim proceeds, which is what the route does.
    await recordFind(user, { sessionId: session.id, cardId: card(1), variant: 'normal', paidCents: 100 });
    const summary = await sessionSummary(user, session.id);
    expect(summary.finds).toBe(1);
    expect(summary.spentCents).toBe(100);
  });
});

describe('the rate limit under concurrency', () => {
  it('admits exactly the budget when everyone arrives at once', async () => {
    const bucket = `conc-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => consumeRateLimit(bucket, 12, 300)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(12);
  });
});
