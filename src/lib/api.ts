import { NextResponse } from 'next/server';
import { z } from 'zod';
import { AuthError, currentUser, type CurrentUser } from './auth/session';
import { isVariantTokenShape } from './catalog/variants';
import { CONDITIONS } from './domain/conditions';
import { consumeRateLimit } from './services/pg';

/**
 * Route-handler plumbing.
 *
 * Every handler receives the Supabase-authenticated user id. Data access then
 * runs under that identity so RLS decides what is reachable — the handler does
 * not filter, and could not bypass the policies if it tried.
 */
export async function withUser<T>(
  fn: (ctx: { user: CurrentUser }) => Promise<T> | T,
): Promise<NextResponse> {
  try {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    const data = await fn({ user });
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
    // A PostgreSQL authorization failure is a 403, not a generic 400.
    if (/row-level security|permission denied/i.test(message)) {
      return NextResponse.json({ error: 'Not permitted' }, { status: 403 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export async function limitOrThrow(
  bucket: string,
  rule: { limit: number; windowSeconds: number },
): Promise<void> {
  const r = await consumeRateLimit(bucket, rule.limit, rule.windowSeconds);
  if (!r.allowed) {
    throw new RateLimitError(
      `Too many attempts. Try again in ${r.retry_after_seconds}s.`,
      r.retry_after_seconds,
    );
  }
}

// Any structurally-valid printing token (base finish, or finish__treatment from
// migration 0021). Existence for the specific card is authoritative in the
// database (the add path verifies the card_variants row), so this stays a shape
// check rather than a second allow-list that could fall behind the catalog.
export const variantSchema = z.string().refine(isVariantTokenShape, 'unknown printing');
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
