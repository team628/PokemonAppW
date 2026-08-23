import { NextResponse } from 'next/server';
import { serverClient, supabaseConfigured } from '@/lib/auth/supabase';

/**
 * Supabase Auth redirect target for magic links, email confirmation and
 * password recovery. Exchanges the one-time code for a session cookie.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/app';

  if (code && supabaseConfigured()) {
    const supabase = await serverClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  return NextResponse.redirect(new URL('/signin?error=link', url.origin));
}
