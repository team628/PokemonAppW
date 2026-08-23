import { z } from 'zod';
import { limitOrThrow, withUser } from '@/lib/api';
import { reportCatalogGap } from '@/lib/services/pg';

const body = z.object({
  term: z.string().trim().min(1).max(120),
  setId: z.string().max(40).nullish(),
  resultCount: z.number().int().min(0).max(1000).optional(),
});

/**
 * "Can't find my card" — a collector tells us a search term they could not
 * resolve. Rate-limited so it stays a signal, not a spam vector; scoped to the
 * one use (recording the term for later catalog review), nothing more.
 */
export async function POST(req: Request) {
  return withUser(async ({ user }) => {
    const input = body.parse(await req.json());
    await limitOrThrow(`catalog-gap:${user.id}`, { limit: 20, windowSeconds: 3600 });
    await reportCatalogGap(user.id, input);
    return { ok: true };
  });
}
