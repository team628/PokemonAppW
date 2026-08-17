import { withUser } from '@/lib/api';
import { togglePin } from '@/lib/services/pg';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withUser(async ({ user }) => {
    await togglePin(user.id, id);
    return { ok: true };
  });
}
