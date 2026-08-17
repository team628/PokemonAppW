/**
 * Builds a synthetic collector population for load testing, in PostgreSQL.
 *
 * Deterministic, so before/after runs are comparable. Every identity it creates
 * carries the `load-` email prefix and is deleted on the next run, so it never
 * disturbs demo or development accounts sitting in the same database.
 *
 *   npx tsx tests/load/generate.ts <users>
 */
import { withServiceRole, closePool } from '../../src/lib/db/pg';
import type { GoalMode } from '../../src/lib/domain/goals';

const N = Number(process.argv[2] ?? 1000);

const SETS: [string, GoalMode][] = [
  ['sv3pt5', 'master'], ['base1', 'main'], ['swsh7', 'main'], ['sv1', 'main'],
  ['xy12', 'main'], ['sm12', 'main'], ['swsh12pt5', 'main'], ['neo1', 'main'],
];

let seed = 12345;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

async function main() {
  const t0 = Date.now();

  // Requirements come from the same SQL function the product uses, so the
  // synthetic collections sit on exactly the slots a real goal would.
  const reqs = new Map<string, { card_id: string; variant: string }[]>();
  await withServiceRole(async (tx) => {
    for (const [s, m] of SETS) {
      reqs.set(
        `${s}:${m}`,
        await tx.rows<{ card_id: string; variant: string }>(
          'select card_id, variant from public.goal_required_slots($1, $2)',
          [s, m],
        ),
      );
    }
  });

  console.log('clearing the previous load population…');
  await withServiceRole((tx) =>
    tx.exec("delete from auth.users where email like 'load-%@example.test'"),
  );

  // One transaction per batch of collectors: a single transaction holding
  // 5,000 users' worth of inserts would keep the want-index triggers' locks
  // open for the whole run and tell us nothing useful about throughput.
  const BATCH = 250;
  for (let start = 0; start < N; start += BATCH) {
    const end = Math.min(start + BATCH, N);
    await withServiceRole(async (tx) => {
      for (let i = start; i < end; i++) {
        const u = (await tx.one<{ id: string }>(
          `insert into auth.users (email, raw_user_meta_data)
           values ($1::citext, jsonb_build_object('display_name', $2::text))
           returning id`,
          [`load-${i}@example.test`, `Collector ${i}`],
        ))!;

        const nGoals = 1 + Math.floor(rand() * 3);
        for (let g = 0; g < nGoals; g++) {
          const [setId, mode] = SETS[Math.floor(rand() * SETS.length)]!;
          await tx.exec(
            `insert into public.set_goals (user_id, set_id, mode) values ($1::uuid, $2, $3)
             on conflict do nothing`,
            [u.id, setId, mode],
          );

          const list = reqs.get(`${setId}:${mode}`)!;
          const share = 0.2 + rand() * 0.7;
          const cardIds: string[] = [];
          const variants: string[] = [];
          const quantities: number[] = [];
          const forTrade: boolean[] = [];
          for (const r of list) {
            if (rand() > share) continue;
            const qty = rand() < 0.15 ? 2 : 1;
            cardIds.push(r.card_id);
            variants.push(r.variant);
            quantities.push(qty);
            forTrade.push(qty > 1 && rand() < 0.5);
          }
          if (!cardIds.length) continue;

          await tx.exec(
            `insert into public.collection_items (user_id, card_id, variant, condition, quantity, for_trade)
             select $1::uuid, c, v, 'NM', q, t
             from unnest($2::text[], $3::text[], $4::int[], $5::boolean[]) as x(c, v, q, t)
             on conflict do nothing`,
            [u.id, cardIds, variants, quantities, forTrade],
          );
        }
      }
    });
    console.log(`  ${end}/${N} users (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  // A deliberately extreme collector: the "obsessive" case the product targets.
  console.log('creating the 15,000-card whale…');
  await withServiceRole(async (tx) => {
    const whale = (await tx.one<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data)
       values ('load-whale@example.test', jsonb_build_object('display_name', 'Whale'))
       returning id`,
    ))!;
    for (const [setId, mode] of SETS) {
      await tx.exec(
        `insert into public.set_goals (user_id, set_id, mode) values ($1::uuid, $2, $3)
         on conflict do nothing`,
        [whale.id, setId, mode],
      );
    }
    await tx.exec(
      `insert into public.collection_items (user_id, card_id, variant, condition, quantity)
       select $1::uuid, card_id, variant, 'NM', 1
       from public.card_variants limit 15000
       on conflict do nothing`,
      [whale.id],
    );
  });

  const stats = await withServiceRole(async (tx) =>
    (await tx.one<{ users: number; goals: number; items: number; wants: number }>(
      `select (select count(*) from public.profiles)::int as users,
              (select count(*) from public.set_goals)::int as goals,
              (select count(*) from public.collection_items)::int as items,
              (select count(*) from public.want_index where collectors > 0)::int as wants`,
    ))!,
  );
  console.log(
    `users=${stats.users} goals=${stats.goals} items=${stats.items} open_wants=${stats.wants}`,
  );
  console.log(`generated in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error(e);
    await closePool();
    process.exit(1);
  });
