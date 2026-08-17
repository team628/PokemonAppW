import { createServerClient, createBrowserClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * Supabase Auth clients.
 *
 * Supabase Auth is the authoritative identity: the user id it issues is the
 * `auth.users.id` every RLS policy compares against, and the JWT it mints is
 * what the database runs queries under. There is no parallel password or
 * session store — the previous scrypt/opaque-token implementation was removed
 * with this migration.
 */

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** True when a real Supabase project is configured. */
export function supabaseConfigured(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export function browserClient() {
  return createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

/** Server component / route handler client, backed by the request cookie jar. */
export async function serverClient() {
  const jar = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) jar.set(name, value, options);
        } catch {
          // Called from a Server Component, where the jar is read-only. The
          // middleware refresh below is what keeps the session current.
        }
      },
    },
  });
}

/**
 * Middleware client. Refreshing the session here is what lets Server Components
 * read a valid session without being able to write cookies themselves.
 */
export function middlewareClient(req: NextRequest, res: NextResponse) {
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
      },
    },
  });
}

/**
 * Service-role client for background jobs.
 *
 * Never construct this from a request handler that carries a user's identity —
 * it bypasses RLS by design.
 */
export function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return createServerClient(SUPABASE_URL, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
