/**
 * Creates demo collectors so the app can be exercised end to end with real
 * catalog and price data.
 *
 * Deterministic: the same cards are owned on every run, so screenshots and
 * manual checks are reproducible. Nothing here is used by the app at runtime.
 *
 *   npx tsx scripts/seed-demo.ts
 */
import { withServiceRole, closePool, type Tx } from '../src/lib/db/pg';
import type { GoalMode } from '../src/lib/domain/goals';

/** Small deterministic PRNG so "random" holdings are identical run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

async function fill(
  tx: Tx,
  userId: string,
  setId: string,
  mode: GoalMode,
  share: number,
  seed: number,
  opts: { dupeShare?: number } = {},
) {
  const required = await tx.rows<{ card_id: string; variant: string; market_cents: number | null }>(
    'select card_id, variant, market_cents from public.set_requirements($1, $2)',
    [setId, mode],
  );
  const rand = rng(seed);
  let added = 0;

  for (const r of required) {
    if (rand() > share) continue;
    const quantity = opts.dupeShare && rand() < opts.dupeShare ? 2 + Math.floor(rand() * 2) : 1;
    // Most cards are Near Mint; a realistic collection has a played tail.
    const roll = rand();
    const condition = roll > 0.985 ? 'MP' : roll > 0.93 ? 'LP' : 'NM';
    // Purchase prices on roughly a third of cards, near market.
    const paid =
      r.market_cents !== null && rand() < 0.34
        ? Math.max(1, Math.round(r.market_cents * (0.7 + rand() * 0.5)))
        : null;

    await tx.exec(
      `insert into public.collection_items (user_id, card_id, variant, condition, quantity, paid_cents)
       values ($1::uuid, $2, $3, $4, $5, $6)
       on conflict do nothing`,
      [userId, r.card_id, r.variant, condition, quantity, paid],
    );
    added++;
  }
  return { added, required: required.length };
}

async function main() {
  // A demo account is an open door if this ever runs against a real deployment.
  if (process.env.NODE_ENV === 'production' && process.env.SETVALUE_ALLOW_DEMO_SEED !== 'yes') {
    console.error(
      'refusing to seed demo accounts with NODE_ENV=production.\n' +
        'Set SETVALUE_ALLOW_DEMO_SEED=yes only if you genuinely want demo logins in production.',
    );
    process.exit(1);
  }

  await withServiceRole(async (tx) => {
    const existing = await tx.one<{ id: string }>(
      "select id from auth.users where email = 'demo@setvalue.app'",
    );
    if (existing) {
      console.log('demo users already exist — nothing to do');
      return;
    }

    const mkUser = async (email: string, name: string, handle: string) => {
      const u = (await tx.one<{ id: string }>(
        `insert into auth.users (email, raw_user_meta_data)
         values ($1::citext, jsonb_build_object('display_name', $2::text))
         returning id`,
        [email, name],
      ))!;
      await tx.exec('update public.profiles set handle = $1::citext where id = $2::uuid', [
        handle, u.id,
      ]);
      return u.id;
    };

    const demo = await mkUser('demo@setvalue.app', 'Riley', 'riley');
    const kai = await mkUser('trader@setvalue.app', 'Kai', 'kai');

    // Riley: deep into 151, halfway through Base Set, starting Evolving Skies.
    const plans: [string, GoalMode, number, number, number][] = [
      ['sv3pt5', 'master', 0.92, 20260817, 0.18],
      ['base1', 'main', 0.62, 991999, 0.1],
      ['swsh7', 'main', 0.34, 7777, 0.22],
    ];
    for (const [setId, mode, share, seed, dupeShare] of plans) {
      await tx.exec(
        'insert into public.set_goals (user_id, set_id, mode) values ($1::uuid, $2, $3) on conflict do nothing',
        [demo, setId, mode],
      );
      const { added, required } = await fill(tx, demo, setId, mode, share, seed, { dupeShare });
      console.log(`riley: ${setId} ${mode} — ${added}/${required}`);
    }

    // Kai chases the same sets, so trade matching has something real to find.
    for (const [setId, mode] of [['sv3pt5', 'master'], ['base1', 'main']] as const) {
      await tx.exec(
        'insert into public.set_goals (user_id, set_id, mode) values ($1::uuid, $2, $3) on conflict do nothing',
        [kai, setId, mode],
      );
      const { added, required } = await fill(tx, kai, setId, mode, 0.55, 424242, { dupeShare: 0.3 });
      console.log(`kai:   ${setId} ${mode} — ${added}/${required}`);
    }

    // Kai lists every spare for trade — that is what makes a match visible.
    const listed = await tx.exec(
      'update public.collection_items set for_trade = true where user_id = $1::uuid and quantity > 1',
      [kai],
    );
    console.log(`kai:   ${listed} duplicate stacks listed for trade`);

    console.log('\nSign in as demo@setvalue.app. Identity is provided by Supabase Auth:');
    console.log('  · with a Supabase project configured, set a password for that address there;');
    console.log('  · with local development auth (SETVALUE_ALLOW_LOCAL_AUTH), the email alone signs in.');
  });
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
