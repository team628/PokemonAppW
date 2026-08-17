import { z } from 'zod';
import { withUser } from '@/lib/api';
import { endSession, startSession, sessionSummary } from '@/lib/services/show';

const body = z.object({
  action: z.enum(['start', 'end']),
  name: z.string().max(80).optional(),
  venue: z.string().max(120).nullable().optional(),
  budgetCents: z.number().int().min(0).nullable().optional(),
  sessionId: z.string().optional(),
});

export async function POST(req: Request) {
  return withUser(async ({ user, db }) => {
    const input = body.parse(await req.json());
    if (input.action === 'start') {
      const s = startSession(db, user.id, input);
      return { ok: true, session: s };
    }
    if (!input.sessionId) throw new Error('sessionId is required to end a hunt.');
    const summary = sessionSummary(db, user.id, input.sessionId);
    endSession(db, user.id, input.sessionId);
    return { ok: true, summary };
  });
}
