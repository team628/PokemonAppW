import { addSchema, goalModeSchema, withUser } from '@/lib/api';
import { addToCollection } from '@/lib/services/pg/collection';
import { goalMetrics, syncMilestonesForSet } from '@/lib/services/pg';

const body = addSchema.extend({ withMode: goalModeSchema.optional() });

/**
 * The hot path. Card Show mode calls this on every FOUND IT tap, so the
 * response carries recomputed set metrics — the NEED on screen updates from
 * authoritative data, not from an optimistic guess the client made up.
 */
export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const input = body.parse(await req.json());
    const result = await addToCollection(user.id, input);
    const mode = input.withMode ?? 'main';
    const milestones = result.first_copy ? await syncMilestonesForSet(user.id, result.set_id) : [];
    const m = await goalMetrics(user.id, result.set_id, mode);
    return {
      ok: true,
      itemId: result.item_id,
      quantity: result.quantity,
      firstCopy: result.first_copy,
      setId: result.set_id,
      milestones,
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
