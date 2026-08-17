import { z } from 'zod';
import { withUser } from '@/lib/api';
import { setSharePublic } from '@/lib/auth';

const body = z.object({ isPublic: z.boolean() });

export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const { isPublic } = body.parse(await req.json());
    setSharePublic(db, user.id, isPublic);
    return { ok: true, isPublic };
  });
}
