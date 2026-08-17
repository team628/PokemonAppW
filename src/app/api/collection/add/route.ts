import { addSchema, withUser } from '@/lib/api';
import { addToCollection } from '@/lib/services/collection';
import { metricsForSet } from '@/lib/services/goals';
import { goalModeSchema } from '@/lib/api';
import { z } from 'zod';

const body = addSchema.extend({ withMode: goalModeSchema.optional() });

/**
 * The hot path. Card Show mode calls this on every FOUND IT tap, so the
 * response carries the recomputed set metrics — the NEED number on screen
 * updates from authoritative data, not from an optimistic guess the client
 * made up.
 */
export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const input = body.parse(await req.json());
    const result = addToCollection(db, user.id, input);
    const mode = input.withMode ?? 'main';
    const metrics = metricsForSet(db, user.id, result.setId, mode);
    return {
      ok: true,
      itemId: result.itemId,
      quantity: result.quantity,
      firstCopy: result.firstCopy,
      setId: result.setId,
      milestones: result.milestones.map((m) => m.kind),
      metrics: {
        mode,
        ownedCount: metrics.ownedCount,
        requiredCount: metrics.requiredCount,
        missingCount: metrics.missingCount,
        percent: metrics.percent,
        needCents: metrics.needCents,
        haveCents: metrics.haveCents,
        completeCents: metrics.completeCents,
      },
    };
  });
}
