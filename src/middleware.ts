import { NextResponse, type NextRequest } from 'next/server';

/**
 * Security headers.
 *
 * Rate limiting is applied in the handlers themselves rather than here, because
 * middleware runs on the edge runtime where the SQLite-backed counters are not
 * reachable.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};
