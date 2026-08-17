import { withUser } from '@/lib/api';
import { togglePin } from '@/lib/services/goals';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(({ user, db }) => {
    togglePin(db, user.id, id);
    return { ok: true };
  });
}
