'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { getDb } from '@/lib/db';
import { RULES, checkLimit } from '@/lib/rateLimit';
import {
  SESSION_COOKIE,
  authenticate,
  createSession,
  createUser,
  destroySession,
} from '@/lib/auth';

async function startSession(userId: string) {
  const db = getDb();
  const { token, expiresAt } = createSession(db, userId);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

/** Best-effort client address; behind a proxy the forwarded header wins. */
async function addressKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : h.get('x-real-ip')) ?? 'unknown';
}

export async function signUpAction(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('displayName') ?? '');

  const signupLimit = checkLimit(getDb(), `signup:${await addressKey()}`, RULES.signUp);
  if (!signupLimit.allowed) {
    return { error: `Too many accounts created from here. Try again in ${signupLimit.retryAfterSeconds}s.` };
  }

  let userId: string;
  try {
    const user = createUser(getDb(), { email, password, displayName });
    userId = user.id;
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not create that account.' };
  }
  await startSession(userId);
  redirect('/onboarding');
}

export async function signInAction(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const db = getDb();

  // Limited per account and per address: the first stops an attacker grinding
  // one collector's password, the second stops a spray across many accounts.
  const account = checkLimit(db, `signin:acct:${email.trim().toLowerCase()}`, RULES.signIn);
  const source = checkLimit(db, `signin:addr:${await addressKey()}`, RULES.signIn);
  if (!account.allowed || !source.allowed) {
    const wait = Math.max(account.retryAfterSeconds, source.retryAfterSeconds);
    return { error: `Too many sign-in attempts. Try again in ${wait}s.` };
  }

  const user = authenticate(db, email, password);
  if (!user) return { error: 'That email and password combination did not match.' };
  await startSession(user.id);
  redirect('/app');
}

export async function signOutAction() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) destroySession(getDb(), token);
  jar.delete(SESSION_COOKIE);
  redirect('/');
}
