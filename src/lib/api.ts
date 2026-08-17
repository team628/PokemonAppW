import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, currentUser, type User } from './auth';
import { RateLimitError } from './rateLimit';
import { getDb, type DB } from './db';
import { VARIANTS } from './catalog/variants';
import { CONDITIONS } from './domain/conditions';

/** Thin wrapper so every handler gets a user + db and errors come out uniform. */
export async function withUser<T>(
  fn: (ctx: { user: User; db: DB }) => Promise<T> | T,
): Promise<NextResponse> {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const data = await fn({ user, db: getDb() });
    return NextResponse.json(data ?? { ok: true });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 401 });
    if (e instanceof RateLimitError) {
      return NextResponse.json(
        { error: e.message },
        { status: 429, headers: { 'Retry-After': String(e.retryAfterSeconds) } },
      );
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request', issues: e.issues }, { status: 400 });
    }
    const message = e instanceof Error ? e.message : 'Something went wrong';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const variantSchema = z.enum(VARIANTS);
export const conditionSchema = z.enum(CONDITIONS);
export const goalModeSchema = z.enum(['main', 'complete', 'master']);

export const addSchema = z.object({
  cardId: z.string().min(1),
  variant: variantSchema,
  condition: conditionSchema.optional(),
  quantity: z.number().int().min(1).max(999).optional(),
  paidCents: z.number().int().min(0).nullable().optional(),
  acquiredOn: z.string().nullable().optional(),
  sourceNote: z.string().max(200).nullable().optional(),
  gradeCompany: z.string().max(20).nullable().optional(),
  gradeValue: z.string().max(10).nullable().optional(),
});

export const removeSchema = z.object({
  cardId: z.string().min(1),
  variant: variantSchema,
  condition: conditionSchema.optional(),
  quantity: z.number().int().min(1).max(999).optional(),
});
