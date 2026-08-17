import { z } from 'zod';
import { conditionSchema, withUser } from '@/lib/api';
import { updateItem } from '@/lib/services/pg/collection';

const patch = z.object({
  quantity: z.number().int().min(0).max(999).optional(),
  condition: conditionSchema.optional(),
  paidCents: z.number().int().min(0).nullable().optional(),
  forTrade: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(async ({ user }) => {
    // RLS scopes the update to the caller: another collector's row matches
    // nothing, and we say so rather than returning a false success.
    const changed = await updateItem(user.id, id, patch.parse(await req.json()));
    if (!changed) throw new Error('No such item in your collection.');
    return { ok: true };
  });
}
