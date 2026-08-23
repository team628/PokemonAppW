import { createServerClient } from '@supabase/ssr';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * The Supabase client the middleware uses, in a module of its own.
 *
 * Separate from `supabase.ts` because middleware is bundled for the edge
 * runtime and runs on every matched request. Pulling in that module would drag
 * `next/headers` and the browser client along with it — code the middleware
 * never runs but still pays to load. Keeping the edge path to one import of
 * `@supabase/ssr` is worth the duplicated three lines.
 *
 * Refreshing the session here is what lets Server Components read a valid
 * session without being able to write cookies themselves.
 */
export function middlewareClient(req: NextRequest, res: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value, options } of list) res.cookies.set(name, value, options);
        },
      },
    },
  );
}
