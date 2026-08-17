import { z } from 'zod';
import { conditionSchema, goalModeSchema, variantSchema, withUser } from '@/lib/api';
import { claimIdempotencyKey, recordFind, sessionSummary } from '@/lib/services/pg/show';
import { goalMetrics, syncMilestonesForSet } from '@/lib/services/pg';

const body = z.object({
  sessionId: z.string().uuid(),
  cardId: z.string().min(1),
  variant: variantSchema,
  paidCents: z.number().int().min(0).nullable().optional(),
  condition: conditionSchema.optional(),
  withMode: goalModeSchema.optional(),
  /** Client-generated so a replayed offline queue cannot double-count. */
  idempotencyKey: z.string().max(64).optional(),
});

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const input = body.parse(await req.json());

    // Card Show mode queues finds while offline and replays them on reconnect.
    // The guard is a unique key in PostgreSQL, so it holds across instances and
    // survives a restart — an in-memory guard re-armed on every deploy.
    if (input.idempotencyKey && !(await claimIdempotencyKey(user.id, input.idempotencyKey))) {
      return { ok: true, duplicate: true };
    }

    const result = await recordFind(user.id, input);
    const mode = input.withMode ?? 'main';
    const milestones = result.first_copy ? await syncMilestonesForSet(user.id, result.set_id) : [];
    const m = await goalMetrics(user.id, result.set_id, mode);

    return {
      ok: true,
      findId: result.find_id,
      marketCents: result.market_cents,
      firstCopy: result.first_copy,
      milestones,
      summary: await sessionSummary(user.id, input.sessionId),
      metrics: {
        setId: result.set_id,
        missingCount: m.missing_count,
        ownedCount: m.owned_count,
        requiredCount: m.required_count,
        percent: m.required_count ? m.owned_count / m.required_count : 0,
        needCents: m.need_cents,
      },
    };
  });
}
