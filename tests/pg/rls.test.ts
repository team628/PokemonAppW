import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withIdentity, withServiceRole, closePool, getPool } from '@/lib/db/pg';

/**
 * The adversarial Row Level Security test.
 *
 * User B authenticates and then attempts to reach User A's data directly at the
 * database layer — the same surface PostgREST exposes — bypassing every page,
 * route handler and service function in the application. Frontend checks are
 * irrelevant here by design: these queries have no `where user_id = ...` filter
 * at all, so anything returned is a real leak.
 *
 * Every assertion is either "zero rows" or "the write was rejected".
 */

let userA = '';
let userB = '';
const suffix = randomUUID().slice(0, 8);

async function seedUser(email: string, handle: string): Promise<string> {
  return withServiceRole(async (tx) => {
    const row = await tx.one<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1::citext, jsonb_build_object('display_name', $2::text))
       returning id`,
      [email, handle],
    );
    return row!.id;
  });
}

beforeAll(async () => {
  userA = await seedUser(`rls-a-${suffix}@example.test`, `rlsa${suffix}`);
  userB = await seedUser(`rls-b-${suffix}@example.test`, `rlsb${suffix}`);

  await withServiceRole(async (tx) => {
    // Minimal catalog.
    await tx.exec(
      `insert into public.sets (id, name, series, printed_total, total, release_date)
       values ($1, 'RLS Set', 'Testing', 2, 2, '2023-01-01') on conflict do nothing`,
      [`rls${suffix}`],
    );
    for (const [n, name] of [
      ['1', 'Alpha'],
      ['2', 'Beta'],
    ] as const) {
      await tx.exec(
        `insert into public.cards (id, set_id, number, number_sort, name, rarity)
         values ($1, $2, $3, $4, $5, 'Common') on conflict do nothing`,
        [`rls${suffix}-${n}`, `rls${suffix}`, n, Number(n), name],
      );
      await tx.exec(
        `insert into public.card_variants (card_id, variant, source, is_primary)
         values ($1, 'normal', 'market_data', true) on conflict do nothing`,
        [`rls${suffix}-${n}`],
      );
      await tx.exec(
        `insert into public.prices (card_id, variant, provider, currency, low_cents, mid_cents, market_cents, observed_on)
         values ($1, 'normal', 'tcgplayer', 'USD', 800, 1000, 1000, current_date) on conflict do nothing`,
        [`rls${suffix}-${n}`],
      );
    }
  });

  // User A builds a private collection: a goal, a card, a hunt, a wishlist entry.
  await withIdentity(userA, async (tx) => {
    await tx.exec(
      `insert into public.set_goals (user_id, set_id, mode) values ($1, $2, 'main')`,
      [userA, `rls${suffix}`],
    );
    await tx.rows(`select * from public.add_to_collection($1, 'normal', 2, 'NM', 4200)`, [
      `rls${suffix}-1`,
    ]);
    await tx.exec(
      `insert into public.wishlist_items (user_id, card_id, variant) values ($1, $2, 'normal')`,
      [userA, `rls${suffix}-2`],
    );
    await tx.exec(`insert into public.show_sessions (user_id, name) values ($1, 'A private hunt')`, [
      userA,
    ]);
  });
}, 30_000);

afterAll(async () => {
  await withServiceRole(async (tx) => {
    const ids = [userA, userB].filter(Boolean);
    if (ids.length) await tx.exec('delete from auth.users where id = any($1::uuid[])', [ids]);
    await tx.exec('delete from public.sets where id = $1', [`rls${suffix}`]);
  });
  await closePool();
});

describe('RLS — User B cannot reach User A', () => {
  it('sees no collection rows at all, unfiltered', async () => {
    const rows = await withIdentity(userB, (tx) =>
      tx.rows('select * from public.collection_items'),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot target User A by id', async () => {
    const rows = await withIdentity(userB, (tx) =>
      tx.rows('select * from public.collection_items where user_id = $1', [userA]),
    );
    expect(rows).toHaveLength(0);
  });

  it('sees none of User A"s tracked sets', async () => {
    const rows = await withIdentity(userB, (tx) => tx.rows('select * from public.set_goals'));
    expect(rows).toHaveLength(0);
  });

  it('sees none of User A"s goals even by explicit id', async () => {
    const goalId = await withIdentity(userA, async (tx) =>
      (await tx.one<{ id: string }>('select id from public.set_goals limit 1'))!.id,
    );
    const rows = await withIdentity(userB, (tx) =>
      tx.rows('select * from public.set_goals where id = $1', [goalId]),
    );
    expect(rows).toHaveLength(0);
  });

  it('sees no wishlist, events, milestones, hunts or finds', async () => {
    for (const table of [
      'wishlist_items',
      'collection_events',
      'milestones',
      'show_sessions',
      'show_finds',
      'idempotency_keys',
    ]) {
      const rows = await withIdentity(userB, (tx) => tx.rows(`select * from public.${table}`));
      expect(rows, table).toHaveLength(0);
    }
  });

  it('cannot see User A"s private profile', async () => {
    const rows = await withIdentity(userB, (tx) =>
      tx.rows('select * from public.profiles where id = $1', [userA]),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot compute User A"s completion through the aggregate functions', async () => {
    // goal_metrics is SECURITY INVOKER, so ownership resolves through RLS: B
    // asking about A's set sees an empty collection, not A's progress.
    const rows = await withIdentity(userB, (tx) =>
      tx.rows<{ owned_count: number }>(`select * from public.goal_metrics($1, 'main')`, [
        `rls${suffix}`,
      ]),
    );
    expect(rows[0]!.owned_count).toBe(0);
  });

  it('cannot insert a row owned by User A', async () => {
    await expect(
      withIdentity(userB, (tx) =>
        tx.exec(
          `insert into public.collection_items (user_id, card_id, variant, quantity)
           values ($1, $2, 'normal', 1)`,
          [userA, `rls${suffix}-2`],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot update User A"s cards', async () => {
    const changed = await withIdentity(userB, (tx) =>
      tx.exec('update public.collection_items set quantity = 99'),
    );
    expect(changed).toBe(0);

    const stillTwo = await withIdentity(userA, (tx) =>
      tx.one<{ quantity: number }>('select quantity from public.collection_items limit 1'),
    );
    expect(stillTwo!.quantity).toBe(2);
  });

  it('cannot delete User A"s cards', async () => {
    const deleted = await withIdentity(userB, (tx) =>
      tx.exec('delete from public.collection_items'),
    );
    expect(deleted).toBe(0);
    const survives = await withIdentity(userA, (tx) =>
      tx.rows('select 1 from public.collection_items'),
    );
    expect(survives).toHaveLength(1);
  });

  it('cannot flip User A"s collection to public', async () => {
    const changed = await withIdentity(userB, (tx) =>
      tx.exec('update public.profiles set share_public = true where id = $1', [userA]),
    );
    expect(changed).toBe(0);
  });

  it('cannot escalate its own row to another user id', async () => {
    await withIdentity(userB, (tx) =>
      tx.rows(`select * from public.add_to_collection($1, 'normal', 1)`, [`rls${suffix}-2`]),
    );
    await expect(
      withIdentity(userB, (tx) =>
        tx.exec('update public.collection_items set user_id = $1', [userA]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('cannot read or reset the rate-limit table', async () => {
    await expect(
      withIdentity(userB, (tx) => tx.rows('select * from public.rate_limits')),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withIdentity(userB, (tx) => tx.exec('delete from public.rate_limits')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot write to the shared catalog', async () => {
    await expect(
      withIdentity(userB, (tx) =>
        tx.exec(`update public.prices set market_cents = 1 where card_id = $1`, [`rls${suffix}-1`]),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });

  it('cannot forge demand by writing the want index', async () => {
    await expect(
      withIdentity(userB, (tx) =>
        tx.exec(
          `insert into public.want_index (card_id, variant, collectors) values ($1, 'normal', 9999)`,
          [`rls${suffix}-1`],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('RLS — anonymous callers', () => {
  it('read the catalog but no collector data', async () => {
    const cards = await withIdentity(null, (tx) =>
      tx.rows('select 1 from public.cards where set_id = $1', [`rls${suffix}`]),
    );
    expect(cards.length).toBeGreaterThan(0);

    for (const table of ['collection_items', 'set_goals', 'wishlist_items', 'show_sessions']) {
      const rows = await withIdentity(null, (tx) => tx.rows(`select * from public.${table}`));
      expect(rows, table).toHaveLength(0);
    }
  });

  it('cannot see a private profile, and can see a public one', async () => {
    const before = await withIdentity(null, (tx) =>
      tx.rows('select * from public.profiles where id = $1', [userA]),
    );
    expect(before).toHaveLength(0);

    await withIdentity(userA, (tx) =>
      tx.exec('update public.profiles set share_public = true where id = $1', [userA]),
    );

    const after = await withIdentity(null, (tx) =>
      tx.rows('select * from public.profiles where id = $1', [userA]),
    );
    expect(after).toHaveLength(1);

    // …and closing it again removes it from anonymous view.
    await withIdentity(userA, (tx) =>
      tx.exec('update public.profiles set share_public = false where id = $1', [userA]),
    );
    const closed = await withIdentity(null, (tx) =>
      tx.rows('select * from public.profiles where id = $1', [userA]),
    );
    expect(closed).toHaveLength(0);
  });

  it('cannot enumerate collectors through the profiles table', async () => {
    const all = await withIdentity(null, (tx) => tx.rows('select handle from public.profiles'));
    // Only profiles that opted in are visible; the two test users have not.
    const handles = all.map((r) => (r as { handle: string }).handle);
    expect(handles).not.toContain(`rlsa${suffix}`);
    expect(handles).not.toContain(`rlsb${suffix}`);
  });

  it('cannot write anything', async () => {
    await expect(
      withIdentity(null, (tx) =>
        tx.exec(
          `insert into public.collection_items (user_id, card_id, variant, quantity)
           values ($1, $2, 'normal', 1)`,
          [userA, `rls${suffix}-1`],
        ),
      ),
    ).rejects.toThrow(/row-level security|permission denied/i);
  });
});

describe('RLS is actually enabled everywhere it matters', () => {
  it('has row security on every user-owned table', async () => {
    const rows = await withServiceRole((tx) =>
      tx.rows<{ tablename: string; rowsecurity: boolean }>(
        `select tablename, rowsecurity from pg_tables where schemaname = 'public'`,
      ),
    );
    const unprotected = rows.filter((r) => !r.rowsecurity).map((r) => r.tablename);
    expect(unprotected).toEqual([]);
  });

  it('has no table that is force-disabled for its owner', async () => {
    const rows = await withServiceRole((tx) =>
      tx.rows<{ relname: string }>(
        `select relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      ),
    );
    expect(rows).toEqual([]);
  });

  it('grants no direct table privileges that would bypass a missing policy', async () => {
    // Every user-facing grant must be accompanied by a policy; a table with a
    // grant and no policy is a silent open door.
    const rows = await withServiceRole((tx) =>
      tx.rows<{ table_name: string }>(
        `select t.tablename as table_name
         from pg_tables t
         where t.schemaname = 'public'
           and exists (
             select 1 from information_schema.role_table_grants g
             where g.table_schema = 'public' and g.table_name = t.tablename
               and g.grantee in ('anon','authenticated')
           )
           and not exists (
             select 1 from pg_policies p
             where p.schemaname = 'public' and p.tablename = t.tablename
           )`,
      ),
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });
});
