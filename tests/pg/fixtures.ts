import { randomUUID } from 'node:crypto';
import { withServiceRole } from '@/lib/db/pg';

/**
 * Shared fixtures for the PostgreSQL service tests.
 *
 * Every suite gets its own set id and its own collectors, so suites can run
 * against the same database — including the one carrying the real ingested
 * catalog — without colliding. Identities are created by inserting into
 * `auth.users`, which is exactly what GoTrue does on sign-up and which fires
 * the profile trigger, so the tests exercise the real row shape rather than a
 * hand-built stand-in.
 */

export interface Fixture {
  setId: string;
  cards: { id: string; number: string; name: string; rarity: string; secret: boolean }[];
  cleanup: () => Promise<void>;
}

export async function seedUser(label: string): Promise<string> {
  const suffix = randomUUID().slice(0, 12);
  return withServiceRole(async (tx) => {
    const row = await tx.one<{ id: string }>(
      `insert into auth.users (email, raw_user_meta_data)
       values ($1::citext, jsonb_build_object('display_name', $2::text))
       returning id`,
      [`${label}-${suffix}@example.test`, label],
    );
    return row!.id;
  });
}

/**
 * A four-card set: two commons (each with a reverse holo), one holo rare, and
 * one secret rare. Main = 3 slots, complete = 4, master = 6 — the three modes
 * differ, which is the point.
 */
export async function seedSet(): Promise<Fixture> {
  const setId = `t${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const cards = [
    { id: `${setId}-1`, number: '1', name: 'Bulbafake', rarity: 'Common', secret: false },
    { id: `${setId}-2`, number: '2', name: 'Charfake', rarity: 'Common', secret: false },
    { id: `${setId}-3`, number: '3', name: 'Squirtfake', rarity: 'Rare Holo', secret: false },
    { id: `${setId}-4`, number: '4', name: 'Secretfake', rarity: 'Rare Secret', secret: true },
  ];

  const variants: [string, string, boolean][] = [
    [`${setId}-1`, 'normal', true], [`${setId}-1`, 'reverseHolofoil', false],
    [`${setId}-2`, 'normal', true], [`${setId}-2`, 'reverseHolofoil', false],
    [`${setId}-3`, 'holofoil', true],
    [`${setId}-4`, 'holofoil', true],
  ];

  const prices: [string, string, number][] = [
    [`${setId}-1`, 'normal', 100], [`${setId}-1`, 'reverseHolofoil', 250],
    [`${setId}-2`, 'normal', 200], [`${setId}-2`, 'reverseHolofoil', 400],
    [`${setId}-3`, 'holofoil', 5000],
    [`${setId}-4`, 'holofoil', 20000],
  ];

  await withServiceRole(async (tx) => {
    await tx.exec(
      `insert into public.sets (id, name, series, printed_total, total, release_date)
       values ($1, 'Test Set', 'Testing', 3, 4, date '2023-01-01')`,
      [setId],
    );
    for (const c of cards) {
      await tx.exec(
        `insert into public.cards (id, set_id, number, number_sort, name, rarity, is_secret)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [c.id, setId, c.number, Number(c.number), c.name, c.rarity, c.secret],
      );
    }
    for (const [cardId, variant, primary] of variants) {
      await tx.exec(
        `insert into public.card_variants (card_id, variant, source, is_primary)
         values ($1, $2, 'market_data', $3)`,
        [cardId, variant, primary],
      );
    }
    for (const [cardId, variant, cents] of prices) {
      await tx.exec(
        `insert into public.prices (card_id, variant, provider, currency, low_cents, mid_cents, market_cents, observed_on)
         values ($1, $2, 'tcgplayer', 'USD', $3, $4, $4, current_date)`,
        [cardId, variant, Math.round(cents * 0.8), cents],
      );
      await tx.exec(
        `insert into public.price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
         values ($1, $2, 'tcgplayer', current_date, $3, $4)`,
        [cardId, variant, cents, Math.round(cents * 0.8)],
      );
    }
  });

  return {
    setId,
    cards,
    cleanup: async () => {
      // Cascades take the cards, variants, prices, goals and holdings with it.
      await withServiceRole((tx) => tx.exec('delete from public.sets where id = $1', [setId]));
    },
  };
}

export async function dropUsers(...ids: string[]): Promise<void> {
  if (!ids.length) return;
  await withServiceRole((tx) =>
    tx.exec('delete from auth.users where id = any($1::uuid[])', [ids]),
  );
}
