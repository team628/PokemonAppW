import { NextResponse, type NextRequest } from 'next/server';

/**
 * Session refresh, and security headers.
 *
 * Supabase access tokens are short-lived. A Server Component can read the
 * session but cannot write cookies, so nothing inside the app can store a
 * refreshed token — without a refresh here, a signed-in collector is silently
 * signed out an hour after signing in. Middleware is the one place in the
 * request path that can both read the cookie jar and write it back, so this is
 * where `getUser()` is called: it revalidates the token against the auth server
 * and, when Supabase issues a new pair, writes them onto the response.
 *
 * Two things keep that from becoming a tax on every request.
 *
 * It only runs on paths that carry a session. The landing page, the partner
 * console and a public collection page are read by people who are not signed
 * in; making them wait on an auth round trip would couple an anonymous page's
 * latency to the auth service for no benefit. They still get the headers.
 *
 * And the Supabase client is imported inside that branch, so a deployment with
 * no project configured — and every request to a public path — never evaluates
 * it.
 *
 * Rate limiting deliberately does not happen here. Middleware runs on the edge
 * runtime, which has no TCP socket and therefore no PostgreSQL connection; the
 * counters live in the database so a limit holds across every serverless
 * instance rather than per process, and the handlers apply them.
 */

/** Paths where a signed-in session is expected and must be kept alive. */
const SESSION_PATHS = /^\/(app|onboarding|auth|api\/(collection|goals|import|milestones|profile|show))(\/|$)/;

export async function middleware(req: NextRequest) {
  const res = NextResponse.next({ request: { headers: req.headers } });

  if (
    SESSION_PATHS.test(req.nextUrl.pathname) &&
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  ) {
    const { middlewareClient } = await import('@/lib/auth/supabase-edge');
    // The call itself is the point: it refreshes the session as a side effect.
    // Whether a user comes back is the page's business, not the middleware's —
    // authorization is RLS, and every protected page calls requireUser().
    await middlewareClient(req, res).auth.getUser();
  }

  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
