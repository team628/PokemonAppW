'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { serverClient, supabaseConfigured } from '@/lib/auth/supabase';
import { LOCAL_COOKIE, localAuthEnabled, localSignIn, signLocalIdentity } from '@/lib/auth/session';
import { RULES, consumeRateLimit } from '@/lib/services/pg';

/**
 * Authentication actions.
 *
 * Supabase Auth is the identity provider: password sign-in, magic link and sign
 * out all go through it, and the user id it issues is what RLS enforces
 * against. The local branch exists only where no Supabase project is
 * configured — see src/lib/auth/session.ts.
 */

async function addressKey(): Promise<string> {
  const h = await headers();
  const fwd = h.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0]!.trim() : h.get('x-real-ip')) ?? 'unknown';
}

type State = { error?: string; notice?: string } | null;

export async function signUpAction(_prev: State, formData: FormData): Promise<State> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');
  const displayName = String(formData.get('displayName') ?? '').trim();
  // Private-beta invite code. It travels as signup metadata so the database gate
  // (a trigger on auth.users) validates and atomically consumes it — the check
  // is the database's, never this form's.
  const inviteCode = String(formData.get('inviteCode') ?? '').trim();

  const gate = await consumeRateLimit(`signup:${await addressKey()}`, RULES.signUp.limit, RULES.signUp.windowSeconds);
  if (!gate.allowed) {
    return { error: `Too many accounts created from here. Try again in ${gate.retry_after_seconds}s.` };
  }

  if (supabaseConfigured()) {
    const supabase = await serverClient();
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName, invite_code: inviteCode } },
    });
    if (error) {
      // Account creation is gated in the database (invite-only beta): a
      // BEFORE INSERT trigger on auth.users rejects an un-invited email, which
      // GoTrue surfaces as a generic "Database error saving new user" (HTTP
      // 500). Translate that one case into a clear reason, without confirming
      // whether any particular address is on the list. Genuine input errors
      // (e.g. a weak password, 422) still return their own message. The gate
      // itself is the database's, not this line's — this only affects wording.
      const status = (error as { status?: number }).status;
      if (status === 500 || /database error saving new user/i.test(error.message)) {
        return {
          error:
            'That invite code isn’t valid, has expired, or has already been used. SetValue is in private beta — check the code and try again.',
        };
      }
      return { error: error.message };
    }
    return { notice: 'Check your email to confirm your account, then sign in.' };
  }

  if (!localAuthEnabled()) return { error: 'Authentication is not configured.' };
  const user = await localSignIn(email, displayName);
  (await cookies()).set(LOCAL_COOKIE, signLocalIdentity(user.id), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/onboarding');
}

export async function signInAction(_prev: State, formData: FormData): Promise<State> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  // Limited per account and per address: the first stops an attacker grinding
  // one collector's password, the second stops a spray across many accounts.
  const account = await consumeRateLimit(`signin:acct:${email}`, RULES.signIn.limit, RULES.signIn.windowSeconds);
  const source = await consumeRateLimit(`signin:addr:${await addressKey()}`, RULES.signIn.limit, RULES.signIn.windowSeconds);
  if (!account.allowed || !source.allowed) {
    const wait = Math.max(account.retry_after_seconds, source.retry_after_seconds);
    return { error: `Too many sign-in attempts. Try again in ${wait}s.` };
  }

  if (supabaseConfigured()) {
    const supabase = await serverClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: 'That email and password combination did not match.' };
    redirect('/app');
  }

  if (!localAuthEnabled()) return { error: 'Authentication is not configured.' };
  const user = await localSignIn(email);
  (await cookies()).set(LOCAL_COOKIE, signLocalIdentity(user.id), {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
  redirect('/app');
}

/** Passwordless sign-in. Supabase emails a one-time link back to /auth/callback. */
export async function magicLinkAction(_prev: State, formData: FormData): Promise<State> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();

  const gate = await consumeRateLimit(`magic:${email}`, RULES.signIn.limit, RULES.signIn.windowSeconds);
  if (!gate.allowed) return { error: `Too many links requested. Try again in ${gate.retry_after_seconds}s.` };

  if (!supabaseConfigured()) {
    return { error: 'Magic links require a configured Supabase project.' };
  }
  const h = await headers();
  const origin = h.get('origin') ?? `https://${h.get('host')}`;
  const supabase = await serverClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/auth/callback?next=/app` },
  });
  if (error) return { error: error.message };
  return { notice: 'Check your email — the sign-in link is on its way.' };
}

/** Account recovery, handled by Supabase's password-reset email. */
export async function resetPasswordAction(_prev: State, formData: FormData): Promise<State> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  if (!supabaseConfigured()) return { error: 'Password reset requires a configured Supabase project.' };

  const gate = await consumeRateLimit(`reset:${email}`, RULES.signIn.limit, RULES.signIn.windowSeconds);
  if (!gate.allowed) return { error: `Too many reset requests. Try again in ${gate.retry_after_seconds}s.` };

  const h = await headers();
  const origin = h.get('origin') ?? `https://${h.get('host')}`;
  const supabase = await serverClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/app/profile`,
  });
  if (error) return { error: error.message };
  return { notice: 'If that address has an account, a reset link is on its way.' };
}

export async function signOutAction() {
  if (supabaseConfigured()) {
    const supabase = await serverClient();
    await supabase.auth.signOut();
  }
  (await cookies()).delete(LOCAL_COOKIE);
  redirect('/');
}
