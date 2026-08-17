import { withUser } from '@/lib/api';
import { removeGoal } from '@/lib/services/goals';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(({ user, db }) => {
    removeGoal(db, user.id, id);
    return { ok: true };
  });
}
