import { withUser } from '@/lib/api';
import { removeGoal } from '@/lib/services/pg';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(async ({ user }) => {
    await removeGoal(user.id, id);
    return { ok: true };
  });
}
