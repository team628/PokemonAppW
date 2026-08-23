import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIdentity, withServiceRole, closePool } from '@/lib/db/pg';
import {
  addToCollection, removeFromCollection, updateItem, listHoldingsPage, portfolioSummary,
} from '@/lib/services/pg/collection';
import {
  addGoal, goalMetrics, myGoals, buildInsights, syncMilestonesForSet,
  unseenMilestones, markMilestonesSeen, demandReport, rebuildWantIndex,
} from '@/lib/services/pg';
import { currentOrNewSession, recordFind, sessionSummary, endSession } from '@/lib/services/pg/show';
import { seedSet, seedUser, dropUsers, type Fixture } from './fixtures';

/**
 * Service-layer tests against PostgreSQL with the production schema and the
 * production RLS policies, exercising the paths the app actually calls.
 *
 * Password hashing and session tokens are absent by design: Supabase Auth owns
 * identity now, so there is no application-side credential code left to test.
 * The authorization boundary those tests used to approximate is covered
 * directly and adversarially in tests/pg/rls.test.ts.
 */

let fx: Fixture;
let me = '';
let them = '';
let third = '';

beforeAll(async () => {
  fx = await seedSet();
  [me, them, third] = await Promise.all([seedUser('svc-me'), seedUser('svc-them'), seedUser('svc-third')]);
});

afterAll(async () => {
  await dropUsers(me, them, third);
  await fx.cleanup();
  await closePool();
});

/** Wipe everything the previous test wrote, without touching the catalog. */
async function reset() {
  await withServiceRole(async (tx) => {
    for (const id of [me, them, third]) {
      await tx.exec('delete from public.collection_items where user_id = $1::uuid', [id]);
      await tx.exec('delete from public.set_goals where user_id = $1::uuid', [id]);
      await tx.exec('delete from public.collection_events where user_id = $1::uuid', [id]);
      await tx.exec('delete from public.show_sessions where user_id = $1::uuid', [id]);
    }
  });
}

const card = (n: number) => `${fx.setId}-${n}`;

describe('collection and completion', () => {
  it('computes each goal mode over the right slots', async () => {
    await reset();
    expect((await goalMetrics(me, fx.setId, 'main')).required_count).toBe(3);
    expect((await goalMetrics(me, fx.setId, 'complete')).required_count).toBe(4);
    expect((await goalMetrics(me, fx.setId, 'master')).required_count).toBe(6);
  });

  it('moves a card from NEED to HAVE and keeps the totals reconciling', async () => {
    await reset();
    const before = await goalMetrics(me, fx.setId, 'main');
    expect(before.have_cents).toBe(0);
    expect(before.need_cents).toBe(5300);

    await addToCollection(me, { cardId: card(3), variant: 'holofoil' });

    const after = await goalMetrics(me, fx.setId, 'main');
    expect(after.have_cents).toBe(5000);
    expect(after.need_cents).toBe(300);
    expect(after.complete_cents).toBe(before.complete_cents);
    expect(after.have_cents + after.need_cents).toBe(after.complete_cents);
    expect(after.owned_count).toBe(1);
  });

  it('does not let a reverse holo satisfy a main-set slot', async () => {
    await reset();
    await addToCollection(me, { cardId: card(1), variant: 'reverseHolofoil' });
    expect((await goalMetrics(me, fx.setId, 'main')).owned_count).toBe(0);
    expect((await goalMetrics(me, fx.setId, 'master')).owned_count).toBe(1);
  });

  it('stacks copies and returns them on removal', async () => {
    await reset();
    await addToCollection(me, { cardId: card(1), variant: 'normal' });
    const second = await addToCollection(me, { cardId: card(1), variant: 'normal' });
    expect(second.quantity).toBe(2);
    expect(second.first_copy).toBe(false);

    await removeFromCollection(me, { cardId: card(1), variant: 'normal' });
    expect((await goalMetrics(me, fx.setId, 'main')).owned_count).toBe(1);

    await removeFromCollection(me, { cardId: card(1), variant: 'normal' });
    expect((await goalMetrics(me, fx.setId, 'main')).owned_count).toBe(0);
  });

  it('keeps different conditions as separate holdings and prices them apart', async () => {
    await reset();
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', condition: 'NM' });
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', condition: 'HP' });

    const page = await listHoldingsPage(me);
    expect(page.rows).toHaveLength(2);
    const nm = page.rows.find((h) => h.condition === 'NM')!;
    const hp = page.rows.find((h) => h.condition === 'HP')!;
    expect(nm.estimatedValueCents).toBe(5000);
    expect(hp.estimatedValueCents).toBe(2500); // 50% band for Heavily Played
    expect(hp.conditionAdjusted).toBe(true);
    // The observed figure is kept beside the estimate rather than replaced by it.
    expect(hp.observedMarketCents).toBe(5000);
  });

  it('summarises a portfolio including cost basis and duplicates', async () => {
    await reset();
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', paidCents: 3000 });
    await addToCollection(me, { cardId: card(1), variant: 'normal', quantity: 3 });

    const s = await portfolioSummary(me);
    expect(s.totalCards).toBe(4);
    expect(s.uniqueCards).toBe(2);
    expect(s.estimatedValueCents).toBe(5000 + 300);
    expect(s.costBasisCents).toBe(3000);
    expect(s.gainCents).toBe(2000);
    expect(s.duplicateCopies).toBe(2);
  });

  it('deletes a holding when its quantity is edited to zero', async () => {
    await reset();
    const added = await addToCollection(me, { cardId: card(1), variant: 'normal', quantity: 2 });
    await updateItem(me, added.item_id, { quantity: 0 });
    expect((await listHoldingsPage(me)).rows).toHaveLength(0);
  });
});

describe('milestones', () => {
  it('fires each milestone once and never re-fires it', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');

    await addToCollection(me, { cardId: card(1), variant: 'normal' });
    await syncMilestonesForSet(me, fx.setId);
    await addToCollection(me, { cardId: card(2), variant: 'normal' });
    await syncMilestonesForSet(me, fx.setId);

    let kinds = (await unseenMilestones(me)).map((m) => m.kind);
    expect(kinds).toContain('started');
    expect(kinds).toContain('one_left');
    await markMilestonesSeen(me);

    await addToCollection(me, { cardId: card(3), variant: 'holofoil' });
    await syncMilestonesForSet(me, fx.setId);
    kinds = (await unseenMilestones(me)).map((m) => m.kind);
    expect(kinds).toContain('complete');

    // Sell a card and re-acquire it: the moment already happened.
    await markMilestonesSeen(me);
    await removeFromCollection(me, { cardId: card(3), variant: 'holofoil' });
    await syncMilestonesForSet(me, fx.setId);
    await addToCollection(me, { cardId: card(3), variant: 'holofoil' });
    await syncMilestonesForSet(me, fx.setId);
    expect(await unseenMilestones(me)).toHaveLength(0);

    const n = await withIdentity(me, async (tx) =>
      (await tx.one<{ n: number }>(
        "select count(*)::int as n from public.milestones where kind = 'complete'",
      ))!.n,
    );
    expect(n).toBe(1);
  });

  it('carries everything a completion card needs, and only on the transition', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    for (const [c, v] of [[1, 'normal'], [2, 'normal'], [3, 'holofoil']] as const) {
      await addToCollection(me, { cardId: card(c), variant: v });
    }
    await syncMilestonesForSet(me, fx.setId);

    const complete = (await unseenMilestones(me)).find((m) => m.kind === 'complete');
    expect(complete, 'finishing a set must produce a completion milestone').toBeTruthy();

    // The card names the set out of context and dates the accomplishment.
    expect(complete!.set_id).toBe(fx.setId);
    expect(complete!.set_name).toBeTruthy();
    expect(complete!.mode).toBe('main');
    expect(complete!.collector).toBeTruthy();
    expect(complete!.completed_at, 'the completion date is what makes it an artefact').toBeTruthy();
    const payload = complete!.payload as Record<string, number>;
    expect(payload.requiredCount).toBe(3);
    expect(payload.completeCents).toBeGreaterThan(0);

    // Seeing it once retires it. Re-reading — a second page load — must not
    // replay the moment.
    await markMilestonesSeen(me);
    expect((await unseenMilestones(me)).map((m) => m.kind)).not.toContain('complete');
    await syncMilestonesForSet(me, fx.setId);
    expect((await unseenMilestones(me)).map((m) => m.kind)).not.toContain('complete');
  });

  it('stamps the goal as completed when the last card lands', async () => {
    await reset();
    const goalId = await addGoal(me, fx.setId, 'main');
    for (const [c, v] of [[1, 'normal'], [2, 'normal'], [3, 'holofoil']] as const) {
      await addToCollection(me, { cardId: card(c), variant: v });
    }
    await syncMilestonesForSet(me, fx.setId);

    const completedAt = await withIdentity(me, async (tx) =>
      (await tx.one<{ completed_at: string | null }>(
        'select completed_at::text from public.set_goals where id = $1::uuid',
        [goalId],
      ))!.completed_at,
    );
    expect(completedAt).not.toBeNull();
  });

  it('writes a journey event for every acquisition', async () => {
    await reset();
    await addToCollection(me, { cardId: card(1), variant: 'normal' });
    await addToCollection(me, { cardId: card(1), variant: 'normal' });
    const types = await withIdentity(me, async (tx) =>
      (await tx.rows<{ type: string }>(
        'select type from public.collection_events order by created_at',
      )).map((e) => e.type),
    );
    expect(types).toContain('card_acquired');
    expect(types).toContain('copy_added');
  });
});

describe('insights', () => {
  it('recommends a finish-line move when a set is nearly done', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    await addToCollection(me, { cardId: card(1), variant: 'normal' });
    await addToCollection(me, { cardId: card(2), variant: 'normal' });

    const { moves } = await buildInsights(me);
    expect(moves[0]!.kind).toBe('finish_line');
    expect(moves[0]!.evidence[0]!.cardId).toBe(card(3));
  });

  it('reports no price movement while only one snapshot exists', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    const insights = await buildInsights(me);
    expect(insights.drops.filter((d) => d.cardId.startsWith(fx.setId))).toHaveLength(0);
  });

  it('detects a real drop once two dated observations exist', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    await withServiceRole((tx) =>
      tx.exec(
        `insert into public.price_points (card_id, variant, provider, observed_on, market_cents, low_cents)
         values ($1, 'holofoil', 'tcgplayer', current_date - 7, 9000, 8000)
         on conflict do nothing`,
        [card(3)],
      ),
    );

    const insights = await buildInsights(me);
    expect(insights.historyTooShallow).toBe(false);
    const drop = insights.drops.find((d) => d.cardId === card(3));
    expect(drop).toBeDefined();
    expect(drop!.previousCents).toBe(9000);
    expect(drop!.currentCents).toBe(5000);
    expect(insights.moves.some((m) => m.kind === 'price_drop')).toBe(true);

    await withServiceRole((tx) =>
      tx.exec('delete from public.price_points where card_id = $1 and observed_on < current_date', [card(3)]),
    );
  });

  it('lists duplicates with their spare count and value', async () => {
    await reset();
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', quantity: 3 });
    const { dupes } = await buildInsights(me);
    const dupe = dupes.find((d) => d.cardId === card(3))!;
    expect(dupe.spareCopies).toBe(2);
    expect(dupe.unitValueCents).toBe(5000);
  });
});

describe('trade matching', () => {
  it('matches another collector’s spare against a hole in my set, both ways', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    await addGoal(them, fx.setId, 'main');

    // I hold spare copies of card 1; they hold spare copies of card 3.
    await addToCollection(me, { cardId: card(1), variant: 'normal', quantity: 2 });
    const theirs = await addToCollection(them, { cardId: card(3), variant: 'holofoil', quantity: 2 });
    await updateItem(them, theirs.item_id, { forTrade: true });

    const { trades } = await buildInsights(me);
    const match = trades.find((t) => t.cardId === card(3));
    expect(match).toBeDefined();
    expect(match!.mutual).toBe(true);
    expect(match!.counterpartHandle).not.toBe('a collector');
  });

  it('does not surface cards that were never marked for trade', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    await addToCollection(them, { cardId: card(3), variant: 'holofoil', quantity: 2 });
    const { trades } = await buildInsights(me);
    expect(trades.filter((t) => t.cardId.startsWith(fx.setId))).toHaveLength(0);
  });

  it('counts demand for my spares without naming anybody', async () => {
    await reset();
    await addGoal(them, fx.setId, 'main');
    await addGoal(third, fx.setId, 'main');
    await addToCollection(me, { cardId: card(3), variant: 'holofoil', quantity: 2 });

    const spares = await withIdentity(me, (tx) =>
      tx.rows<Record<string, unknown>>('select * from public.my_spare_demand()'),
    );
    const spare = spares.find((s) => s.card_id === card(3))!;
    expect(spare.wanted_by).toBe(2);
    expect(Object.keys(spare)).not.toContain('user_id');
    expect(JSON.stringify(spares)).not.toContain(them);
  });

  it('aggregates a partner demand report as counts only', async () => {
    await reset();
    await addGoal(them, fx.setId, 'main');
    await addGoal(third, fx.setId, 'main');
    await addToCollection(them, { cardId: card(3), variant: 'holofoil' });

    await rebuildWantIndex();
    const report = await demandReport(2000, fx.setId);
    const holo = report.find((r) => r.card_id === card(3))!;
    expect(holo.collectors).toBe(1); // only the third collector still needs it
    const common = report.find((r) => r.card_id === card(1))!;
    expect(common.collectors).toBe(2);
    expect(JSON.stringify(report)).not.toContain(them);
  });
});

describe('card show mode', () => {
  it('records a find, adds the card, and reports the running edge', async () => {
    await reset();
    await addGoal(me, fx.setId, 'main');
    const session = await currentOrNewSession(me, 'Saturday show');

    const find = await recordFind(me, {
      sessionId: session.id, cardId: card(3), variant: 'holofoil', paidCents: 3000,
    });
    expect(find.market_cents).toBe(5000);

    const summary = await sessionSummary(me, session.id);
    expect(summary.finds).toBe(1);
    expect(summary.spentCents).toBe(3000);
    expect(summary.marketCents).toBe(5000);
    expect(summary.edgeCents).toBe(2000);

    expect((await goalMetrics(me, fx.setId, 'main')).owned_count).toBe(1);
  });

  it('leaves edge undefined when no price was logged', async () => {
    await reset();
    const session = await currentOrNewSession(me);
    await recordFind(me, { sessionId: session.id, cardId: card(1), variant: 'normal' });
    expect((await sessionSummary(me, session.id)).edgeCents).toBeNull();
  });

  it('refuses to write finds into someone else’s session', async () => {
    await reset();
    const session = await currentOrNewSession(them);
    // RLS is the enforcement, not an application check: the row simply is not
    // visible to me, so the insert has nothing to attach to.
    await expect(
      recordFind(me, { sessionId: session.id, cardId: card(1), variant: 'normal' }),
    ).rejects.toThrow();
  });

  it('logs the hunt to the journey when it ends', async () => {
    await reset();
    const session = await currentOrNewSession(me);
    await recordFind(me, { sessionId: session.id, cardId: card(1), variant: 'normal', paidCents: 50 });
    await endSession(me, session.id);
    const payload = await withIdentity(me, async (tx) =>
      (await tx.one<{ payload: { finds?: number } }>(
        "select payload from public.collection_events where type = 'show_ended' order by created_at desc limit 1",
      ))!.payload,
    );
    expect(payload.finds).toBe(1);
  });
});

describe('goal listing', () => {
  it('returns the sets a collector is chasing with live metrics', async () => {
    await reset();
    await addGoal(me, fx.setId, 'master');
    await addToCollection(me, { cardId: card(4), variant: 'holofoil' });

    const goals = await myGoals(me);
    const g = goals.find((x) => x.setId === fx.setId)!;
    expect(g.mode).toBe('master');
    expect(g.requiredCount).toBe(6);
    expect(g.ownedCount).toBe(1);
    expect(g.haveCents + g.needCents).toBe(g.completeCents);
  });
});
