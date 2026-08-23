import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity, withServiceRole, closePool, type Tx } from '@/lib/db/pg';
import { addToCollection } from '@/lib/services/pg/collection';
import { addGoal, demandPopulation, demandReport, rebuildWantIndex } from '@/lib/services/pg';
import { seedSet, seedUser, dropUsers, type Fixture } from './fixtures';

/**
 * Adversarial review of the partner console's authorization.
 *
 * The partner console is public, unauthenticated and reports on the collector
 * population, so it is the surface where an over-broad privilege becomes a
 * leak. Its figures come from two places that both cross the RLS boundary on
 * purpose: `demand_report()` over the want index, and `demand_population()` for
 * the collector and active-hunt counts.
 *
 * The question these tests answer is not "does the page render numbers" — it is
 * "can a caller standing where the page stands get anything it is not supposed
 * to have". So they run as `anon`, the same role the page runs as, and try.
 *
 * Four of these pin exploits that were live before migration 0013, each one
 * exercised against a real database before it was closed. They would be live
 * again if the grants regressed:
 *
 *   - `user_wants_slot(uuid, text, text)` answered, for *any* user id, whether
 *     that collector was chasing a specific printing and did not own it. RLS
 *     hid their goals; this handed them over one card at a time.
 *   - `want_index_bump(text, text, integer)` sat on PostgreSQL's default PUBLIC
 *     execute, so anonymous traffic could write arbitrary demand counts into
 *     the table every figure on the partner console is derived from.
 *   - `sweep_rate_limits(interval)` deletes every counter in `rate_limits`, and
 *     was likewise public. A bucket that had just refused a request allowed the
 *     next one straight after the call — the sign-in throttle and this page's
 *     own cap, both switched off by anyone.
 *   - `apply_price_observation(...)` writes into `prices` and `price_points`,
 *     and was likewise public. Base Charizard went from $852.43 to $0.01 on an
 *     anonymous call.
 *
 * The last two are not about the partner console's own reads, but they are
 * reachable from exactly where it stands, and they falsify exactly the figures
 * it publishes. A review that stopped at the two functions the page calls would
 * have missed both.
 */

let fx: Fixture;
let alice = '';
let mallory = '';

beforeAll(async () => {
  fx = await seedSet();
  alice = await seedUser('pa-alice');
  mallory = await seedUser('pa-mallory');
  await addGoal(alice, fx.setId, 'master');
  await addToCollection(alice, { cardId: `${fx.setId}-1`, variant: 'normal' });
});

afterAll(async () => {
  await dropUsers(alice, mallory);
  await fx.cleanup();
  await rebuildWantIndex();
  await closePool();
});

/** A statement run as the anonymous web role, with no identity claims at all. */
async function asAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withIdentity(null, fn);
}

describe('population counts', () => {
  it('are reachable anonymously and are only counts', async () => {
    const pop = await demandPopulation();
    expect(Number.isInteger(pop.collectors)).toBe(true);
    expect(Number.isInteger(pop.tracked)).toBe(true);
    expect(pop.collectors).toBeGreaterThan(0);
    expect(pop.tracked).toBeGreaterThan(0);

    // Exactly two columns come back. A future edit that widened this to return
    // handles, emails or set ids would fail here rather than on the page.
    const row = await asAnon((tx) =>
      tx.one<Record<string, unknown>>('select * from public.demand_population()'),
    );
    expect(Object.keys(row!).sort()).toEqual(['collectors', 'tracked']);
  });

  it('matches the true row counts', async () => {
    const truth = await withServiceRole(async (tx) => ({
      collectors: (await tx.one<{ n: number }>(
        'select count(*)::int as n from public.profiles',
      ))!.n,
      tracked: (await tx.one<{ n: number }>(
        'select count(*)::int as n from public.set_goals',
      ))!.n,
    }));
    expect(await demandPopulation()).toEqual(truth);
  });

  it('takes no argument a caller could steer towards an individual', async () => {
    const overloads = await asAnon((tx) =>
      tx.rows<{ args: string }>(
        `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'demand_population'`,
      ),
    );
    expect(overloads).toHaveLength(1);
    expect(overloads[0]!.args).toBe('');

    // And there is no overload to reach for either.
    await expect(
      asAnon((tx) => tx.rows("select * from public.demand_population('any')")),
    ).rejects.toThrow();
  });

  it('is pinned to a search path, so it cannot be redirected', async () => {
    const fn = await asAnon((tx) =>
      tx.one<{ secdef: boolean; config: string[] | null }>(
        `select p.prosecdef as secdef, p.proconfig as config
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'demand_population'`,
      ),
    );
    expect(fn!.secdef, 'it has to be SECURITY DEFINER to see past RLS').toBe(true);
    expect(fn!.config?.join(','), 'a definer function without a fixed search_path is a hazard')
      .toContain('search_path=');
  });

  it('does not widen what anonymous callers can read directly', async () => {
    // The counts exist; the rows behind them still do not.
    const seen = await asAnon(async (tx) => ({
      profiles: (await tx.rows('select * from public.profiles')).length,
      goals: (await tx.rows('select * from public.set_goals')).length,
      items: (await tx.rows('select * from public.collection_items')).length,
      wishlist: (await tx.rows('select * from public.wishlist_items')).length,
      milestones: (await tx.rows('select * from public.milestones')).length,
    }));
    expect(seen).toEqual({ profiles: 0, goals: 0, items: 0, wishlist: 0, milestones: 0 });
  });
});

describe('what the public page can reach', () => {
  it('gets aggregates from the demand report and no collector identity', async () => {
    const report = await demandReport(20);
    expect(report.length).toBeGreaterThan(0);
    for (const row of report) {
      // Card identity and a count. Nothing that names a person.
      expect(Object.keys(row).sort()).toEqual(
        ['card_id', 'collectors', 'image_small', 'market_cents', 'name', 'number', 'rarity', 'set_id', 'set_name', 'variant'],
      );
      expect(Number.isInteger(row.collectors)).toBe(true);
    }
  });

  it('cannot read the private surfaces that feed those aggregates', async () => {
    for (const table of [
      'profiles',
      'set_goals',
      'collection_items',
      'collection_events',
      'wishlist_items',
      'milestones',
      'show_sessions',
      'show_finds',
      'idempotency_keys',
    ]) {
      const n = (await asAnon((tx) => tx.rows(`select * from public.${table}`))).length;
      expect(n, `anon could read ${table}`).toBe(0);
    }
  });

  it('cannot reach cross-collector trade matching at all', async () => {
    // Trade matching is the one audited read that crosses between collectors.
    // It is SECURITY DEFINER, so the grant is the only thing standing between
    // an anonymous caller and other people's opt-in spares.
    await expect(asAnon((tx) => tx.rows('select * from public.trade_matches(5)'))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('gets nothing from the identity-scoped functions it can still call', async () => {
    // `my_spare_demand` is SECURITY INVOKER: it runs with the caller's own
    // rights, so RLS — not a grant — is what empties it. Assert the property
    // rather than the mechanism, because either would be an acceptable answer
    // and only one of them is a leak.
    expect(await asAnon((tx) => tx.rows('select * from public.my_spare_demand(5)'))).toEqual([]);
    expect(await asAnon((tx) => tx.rows('select * from public.my_goals()'))).toEqual([]);
  });
});

describe('the oracle that used to leak individual goals', () => {
  it('no longer exists', async () => {
    const n = await asAnon((tx) =>
      tx.one<{ n: number }>(
        `select count(*)::int as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'user_wants_slot'`,
      ),
    );
    expect(n!.n, 'user_wants_slot answered for an arbitrary user id').toBe(0);
  });

  it('leaves no other SECURITY DEFINER function taking a user id', async () => {
    // The shape of the bug, generalised: a definer function that sees past RLS
    // and lets the caller name whose data to look at.
    const risky = await asAnon((tx) =>
      tx.rows<{ proname: string; args: string }>(
        `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and pg_get_function_identity_arguments(p.oid) like '%uuid%'
           and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
      ),
    );
    expect(risky.map((r) => `${r.proname}(${r.args})`)).toEqual([]);
  });
});

describe('the demand index cannot be written from outside', () => {
  it('refuses an anonymous write through the bump function', async () => {
    await expect(
      asAnon((tx) => tx.rows("select public.want_index_bump('probe-card', 'probe', 999999)")),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses a signed-in write through the bump function', async () => {
    await expect(
      withIdentity(mallory, (tx) =>
        tx.rows("select public.want_index_bump('probe-card', 'probe', 999999)"),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('refuses direct writes to the index at either privilege level', async () => {
    for (const [who, run] of [
      ['anon', <T,>(q: string) => asAnon((tx) => tx.exec(q))],
      ['authenticated', <T,>(q: string) => withIdentity(mallory, (tx) => tx.exec(q))],
    ] as const) {
      await expect(
        run("insert into public.want_index (card_id, variant, collectors) values ('x','y',9)"),
        `${who} could insert into want_index`,
      ).rejects.toThrow();
      await expect(
        run('update public.want_index set collectors = 0'),
        `${who} could update want_index`,
      ).rejects.toThrow();
      await expect(
        run('delete from public.want_index'),
        `${who} could delete from want_index`,
      ).rejects.toThrow();
    }
  });

  it('still maintains itself through the triggers', async () => {
    // Revoking the grant must not have broken the mechanism that uses it: the
    // trigger functions own the privilege, the callers never did.
    const slot = { cardId: `${fx.setId}-2`, variant: 'normal' as const };
    const before = await asAnon((tx) =>
      tx.one<{ n: number }>(
        'select coalesce(collectors, 0)::int as n from public.want_index where card_id = $1 and variant = $2',
        [slot.cardId, slot.variant],
      ),
    );
    await addToCollection(alice, slot);
    const after = await asAnon((tx) =>
      tx.one<{ n: number }>(
        'select coalesce(collectors, 0)::int as n from public.want_index where card_id = $1 and variant = $2',
        [slot.cardId, slot.variant],
      ),
    );
    expect(after!.n, 'owning a card must retire the want').toBe(Math.max(0, (before?.n ?? 0) - 1));
  });
});

describe('the rest of the definer surface anonymous traffic could reach', () => {
  it('cannot disarm the rate limiter', async () => {
    // This was the sharpest of them: sweeping the limiter turned a bucket that
    // had just refused a request back into one that allowed it, which is the
    // sign-in throttle and the partner page's own cap.
    const bucket = `probe:${Date.now()}`;
    const consume = () =>
      asAnon((tx) =>
        tx.one<{ allowed: boolean }>('select allowed from public.consume_rate_limit($1, 3, 300)', [
          bucket,
        ]),
      );
    for (let i = 0; i < 3; i++) await consume();
    expect((await consume())!.allowed, 'the limiter must refuse the fourth call').toBe(false);

    await expect(
      asAnon((tx) => tx.rows("select public.sweep_rate_limits('0 seconds'::interval)")),
    ).rejects.toThrow(/permission denied/i);

    expect((await consume())!.allowed, 'and it must still be refusing afterwards').toBe(false);
  });

  it('cannot write a price', async () => {
    await expect(
      asAnon((tx) =>
        tx.rows(
          `select public.apply_price_observation(
             'base1-4','holofoil','tcgplayer','USD',1,1,1,1,null,current_date)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      withIdentity(mallory, (tx) =>
        tx.rows(
          `select public.apply_price_observation(
             'base1-4','holofoil','tcgplayer','USD',1,1,1,1,null,current_date)`,
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot forge sync history or trigger the heaviest write in the system', async () => {
    for (const call of [
      "public.start_sync_run('manual','forged')",
      "public.mark_card_synced('base1-4', true)",
      'public.refresh_sync_priorities()',
      'public.price_sync_queue(10)',
      'public.rebuild_want_index()',
      "public.sweep_idempotency_keys('0 seconds'::interval)",
    ]) {
      await expect(asAnon((tx) => tx.rows(`select ${call}`)), call).rejects.toThrow(
        /permission denied/i,
      );
    }
  });
});

describe('no SECURITY DEFINER function is reachable by default', () => {
  it('none of them still carries PostgreSQL\'s implicit grant to PUBLIC', async () => {
    // The default on every new function is EXECUTE to PUBLIC, and `grant
    // execute ... to service_role` adds a grant without taking that away. Ten
    // functions were sitting on it. This fails the moment an eleventh appears.
    const open = await asAnon((tx) =>
      tx.rows<{ proname: string; args: string }>(
        `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and (p.proacl is null
                or exists (select 1 from unnest(p.proacl) a where a::text like '=%'))`,
      ),
    );
    expect(open.map((r) => `${r.proname}(${r.args})`)).toEqual([]);
  });

  it('leaves anon holding only the two entry points it needs', async () => {
    const reachable = await asAnon((tx) =>
      tx.rows<{ proname: string }>(
        `select p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prosecdef
           and has_function_privilege('anon', p.oid, 'EXECUTE')
         order by p.proname`,
      ),
    );
    expect(reachable.map((r) => r.proname)).toEqual([
      'consume_rate_limit',
      'demand_population',
      'public_goal_missing',
    ]);
  });
});
