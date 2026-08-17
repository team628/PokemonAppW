import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { serverClient, supabaseConfigured } from './supabase';
import { withServiceRole } from '../db/pg';

/**
 * Resolving the current collector.
 *
 * Production reads the identity from Supabase Auth. The returned id is the
 * `auth.users.id` that every RLS policy compares against, so a request can only
 * ever act as the user Supabase says it is.
 *
 * ---------------------------------------------------------------------------
 * LOCAL DEVELOPMENT ONLY
 *
 * When no Supabase project is configured, a local identity provider stands in
 * so the app and its tests can run against a plain PostgreSQL instance. It is
 * not a parallel production auth system:
 *
 *   * it refuses to activate whenever NEXT_PUBLIC_SUPABASE_URL is set;
 *   * it refuses to activate when NODE_ENV is 'production' unless
 *     SETVALUE_ALLOW_LOCAL_AUTH is explicitly set, which a deployment should
 *     never do;
 *   * it issues the same shape of identity — a uuid in auth.users — so the
 *     database, the policies and the application see no difference;
 *   * it stores no passwords. It is a development stand-in for GoTrue, which
 *     cannot run in this environment.
 *
 * Removing it is a matter of deleting this block once a Supabase project
 * exists; nothing else depends on it.
 * ---------------------------------------------------------------------------
 */

export const LOCAL_COOKIE = 'sv_local_identity';

export function localAuthEnabled(): boolean {
  if (supabaseConfigured()) return false;
  if (process.env.NODE_ENV === 'production' && process.env.SETVALUE_ALLOW_LOCAL_AUTH !== 'yes') {
    return false;
  }
  return true;
}

function localSecret(): string {
  return process.env.SETVALUE_LOCAL_AUTH_SECRET ?? 'local-development-only-secret';
}

export function signLocalIdentity(userId: string): string {
  const mac = createHmac('sha256', localSecret()).update(userId).digest('base64url');
  return `${userId}.${mac}`;
}

export function verifyLocalIdentity(token: string | undefined): string | null {
  if (!token) return null;
  const [id, mac] = token.split('.');
  if (!id || !mac) return null;
  const expected = createHmac('sha256', localSecret()).update(id).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return id;
}

export interface CurrentUser {
  id: string;
  email: string | null;
}

/** The authenticated collector, or null. */
export async function currentUser(): Promise<CurrentUser | null> {
  if (supabaseConfigured()) {
    const supabase = await serverClient();
    // getUser() revalidates the token with the Auth server rather than trusting
    // the cookie contents, which is the difference that matters for a
    // security decision.
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null };
  }

  if (!localAuthEnabled()) return null;
  const jar = await cookies();
  const id = verifyLocalIdentity(jar.get(LOCAL_COOKIE)?.value);
  if (!id) return null;
  return { id, email: null };
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await currentUser();
  if (!u) throw new AuthError();
  return u;
}

export class AuthError extends Error {
  constructor() {
    super('Not signed in');
    this.name = 'AuthError';
  }
}

/**
 * Development-only identity creation. Mirrors what GoTrue does on sign-up:
 * inserts into auth.users, which fires the profile trigger.
 */
export async function localSignIn(email: string, displayName?: string): Promise<CurrentUser> {
  if (!localAuthEnabled()) throw new Error('local identities are disabled');
  const normalized = email.trim().toLowerCase();

  const user = await withServiceRole(async (tx) => {
    const existing = await tx.one<{ id: string }>(
      'select id from auth.users where email = $1::citext',
      [normalized],
    );
    if (existing) return existing;
    return (await tx.one<{ id: string }>(
      `insert into auth.users (id, email, raw_user_meta_data)
       values ($1::uuid, $2::citext, jsonb_build_object('display_name', $3::text))
       returning id`,
      [randomUUID(), normalized, displayName ?? normalized.split('@')[0]],
    ))!;
  });

  return { id: user.id, email: normalized };
}
