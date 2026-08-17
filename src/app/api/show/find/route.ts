import { z } from 'zod';
import { conditionSchema, goalModeSchema, variantSchema, withUser } from '@/lib/api';
import { recordFind, sessionSummary } from '@/lib/services/show';
import { metricsForSet } from '@/lib/services/goals';

const body = z.object({
  sessionId: z.string().min(1),
  cardId: z.string().min(1),
  variant: variantSchema,
  paidCents: z.number().int().min(0).nullable().optional(),
  condition: conditionSchema.optional(),
  withMode: goalModeSchema.optional(),
  /** Client-generated id so a replayed offline queue cannot double-count. */
  idempotencyKey: z.string().max(64).optional(),
});

const seen = new Map<string, number>();

export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const input = body.parse(await req.json());

    // Card Show mode queues finds while offline and replays them on reconnect.
    // Without this guard a flaky hall wifi turns one card into three.
    if (input.idempotencyKey) {
      const k = `${user.id}:${input.idempotencyKey}`;
      const now = Date.now();
      for (const [key, ts] of seen) if (now - ts > 3_600_000) seen.delete(key);
      if (seen.has(k)) return { ok: true, duplicate: true };
      seen.set(k, now);
    }

    const result = recordFind(db, user.id, input);
    const mode = input.withMode ?? 'main';
    const metrics = metricsForSet(db, user.id, result.setId, mode);
    return {
      ok: true,
      findId: result.findId,
      marketCents: result.marketCents,
      firstCopy: result.firstCopy,
      milestones: result.milestones.map((m) => m.kind),
      summary: sessionSummary(db, user.id, input.sessionId),
      metrics: {
        setId: result.setId,
        missingCount: metrics.missingCount,
        ownedCount: metrics.ownedCount,
        requiredCount: metrics.requiredCount,
        percent: metrics.percent,
        needCents: metrics.needCents,
      },
    };
  });
}
