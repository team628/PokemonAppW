import { z } from 'zod';
import { withUser } from '@/lib/api';
import { currentOrNewSession, endSession } from '@/lib/services/pg/show';

const body = z.object({
  action: z.enum(['start', 'end']),
  name: z.string().max(80).optional(),
  sessionId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const input = body.parse(await req.json());
    if (input.action === 'start') {
      return { ok: true, session: await currentOrNewSession(user.id, input.name) };
    }
    if (!input.sessionId) throw new Error('sessionId is required to end a hunt.');
    return { ok: true, summary: await endSession(user.id, input.sessionId) };
  });
}
