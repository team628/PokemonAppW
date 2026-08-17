/**
 * Creates demo collectors so the app can be exercised end to end with real
 * catalog and price data.
 *
 * Deterministic: the same cards are owned on every run, so screenshots and
 * manual checks are reproducible. Nothing here is used by the app at runtime.
 */
import { openDb, nowIso } from '../src/lib/db/index';
import { createUser } from '../src/lib/auth';
import { addToCollection } from '../src/lib/services/collection';
import { addGoal } from '../src/lib/services/goals';
import { setRequirements, primaryVariantMap } from '../src/lib/repo/catalog';
import { requirementsForMode, type GoalMode } from '../src/lib/domain/goals';

/** Small deterministic PRNG so "random" holdings are identical run to run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fill(
  db: ReturnType<typeof openDb>,
  userId: string,
  setId: string,
  mode: GoalMode,
  share: number,
  seed: number,
  opts: { dupeShare?: number } = {},
) {
  const all = setRequirements(db, setId);
  const required = requirementsForMode(all, mode, primaryVariantMap(db, setId));
  const rand = rng(seed);
  let added = 0;

  for (const r of required) {
    if (rand() > share) continue;
    const quantity = opts.dupeShare && rand() < opts.dupeShare ? 2 + Math.floor(rand() * 2) : 1;
    // Most cards are Near Mint; a realistic collection has a played tail.
    const roll = rand();
    const condition = roll > 0.93 ? 'LP' : roll > 0.985 ? 'MP' : 'NM';
    addToCollection(db, userId, {
      cardId: r.cardId,
      variant: r.variant,
      quantity,
      condition,
      // Purchase prices on roughly a third of cards, near market.
      paidCents:
        r.marketCents !== null && rand() < 0.34
          ? Math.max(1, Math.round(r.marketCents * (0.7 + rand() * 0.5)))
          : null,
      acquiredOn: null,
    });
    added++;
  }
  return { added, required: required.length };
}

function main() {
  const db = openDb();

  if (db.prepare("SELECT 1 FROM users WHERE email = 'demo@setvalue.app'").get()) {
    console.log('demo users already exist — nothing to do');
    return;
  }

  const demo = createUser(db, {
    email: 'demo@setvalue.app',
    password: 'setvalue-demo',
    displayName: 'Riley',
    handle: 'riley',
  });
  const misty = createUser(db, {
    email: 'trader@setvalue.app',
    password: 'setvalue-demo',
    displayName: 'Kai',
    handle: 'kai',
  });

  // Riley: deep into 151, halfway through Base Set, starting Evolving Skies.
  const plans: [string, GoalMode, number, number, number][] = [
    ['sv3pt5', 'master', 0.92, 20260817, 0.18],
    ['base1', 'main', 0.62, 991999, 0.1],
    ['swsh7', 'main', 0.34, 7777, 0.22],
  ];
  for (const [setId, mode, share, seed, dupeShare] of plans) {
    addGoal(db, demo.id, setId, mode);
    const { added, required } = fill(db, demo.id, setId, mode, share, seed, { dupeShare });
    console.log(`riley: ${setId} ${mode} — ${added}/${required}`);
  }

  // Kai chases the same sets, so trade matching has something real to find.
  for (const [setId, mode] of [['sv3pt5', 'master'], ['base1', 'main']] as const) {
    addGoal(db, misty.id, setId, mode);
    const { added, required } = fill(db, misty.id, setId, mode, 0.55, 424242, { dupeShare: 0.3 });
    console.log(`kai:   ${setId} ${mode} — ${added}/${required}`);
  }

  // Kai lists every spare for trade — that is what makes a match visible.
  const listed = db
    .prepare('UPDATE collection_items SET for_trade = 1, updated_at = ? WHERE user_id = ? AND quantity > 1')
    .run(nowIso(), misty.id);
  console.log(`kai:   ${listed.changes} duplicate stacks listed for trade`);

  db.close();
  console.log('\ndemo sign-in: demo@setvalue.app / setvalue-demo');
}

main();
