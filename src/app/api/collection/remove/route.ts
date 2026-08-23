import { goalModeSchema, removeSchema, withUser } from '@/lib/api';
import { removeFromCollection } from '@/lib/services/pg/collection';
import { goalMetrics } from '@/lib/services/pg';

const body = removeSchema.extend({ withMode: goalModeSchema.optional() });

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const input = body.parse(await req.json());
    const { remaining, set_id } = await removeFromCollection(user.id, input);
    const mode = input.withMode ?? 'main';
    const m = await goalMetrics(user.id, set_id, mode);
    return {
      ok: true,
      remaining,
      setId: set_id,
      metrics: {
        mode,
        ownedCount: m.owned_count,
        requiredCount: m.required_count,
        missingCount: m.missing_count,
        percent: m.required_count ? m.owned_count / m.required_count : 0,
        needCents: m.need_cents,
        haveCents: m.have_cents,
        completeCents: m.complete_cents,
      },
    };
  });
}
