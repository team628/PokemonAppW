import { z } from 'zod';
import { conditionSchema, withUser } from '@/lib/api';
import { updateItem } from '@/lib/services/collection';

const patch = z.object({
  quantity: z.number().int().min(0).max(999).optional(),
  condition: conditionSchema.optional(),
  paidCents: z.number().int().min(0).nullable().optional(),
  acquiredOn: z.string().nullable().optional(),
  forTrade: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(async ({ user, db }) => {
    updateItem(db, user.id, id, patch.parse(await req.json()));
    return { ok: true };
  });
}
