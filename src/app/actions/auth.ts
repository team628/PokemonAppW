'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getDb } from '@/lib/db';
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

export async function signUpAction(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('displayName') ?? '');

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

  const user = authenticate(getDb(), email, password);
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
