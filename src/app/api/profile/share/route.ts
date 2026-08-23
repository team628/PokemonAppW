import { z } from 'zod';
import { withUser } from '@/lib/api';
import { setSharePublic } from '@/lib/services/pg/profile';

const body = z.object({ isPublic: z.boolean() });

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const { isPublic } = body.parse(await req.json());
    await setSharePublic(user.id, isPublic);
    return { ok: true, isPublic };
  });
}
