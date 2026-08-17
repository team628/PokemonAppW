import { removeSchema, withUser, goalModeSchema } from '@/lib/api';
import { removeFromCollection } from '@/lib/services/collection';
import { metricsForSet } from '@/lib/services/goals';

const body = removeSchema.extend({ withMode: goalModeSchema.optional() });

export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const input = body.parse(await req.json());
    const { remaining, setId } = removeFromCollection(db, user.id, input);
    const mode = input.withMode ?? 'main';
    const metrics = metricsForSet(db, user.id, setId, mode);
    return {
      ok: true,
      remaining,
      setId,
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
