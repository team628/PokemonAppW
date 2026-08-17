'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { signInAction } from '@/app/actions/auth';

export default function SignInPage() {
  const [state, action, pending] = useActionState(signInAction, null);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 text-lg font-black tracking-tight">
        SET<span className="text-need">VALUE</span>
      </Link>
      <h1 className="text-2xl font-bold">Welcome back</h1>
      <p className="mt-1 text-sm text-ink-mute">Your collection is where you left it.</p>

      <form action={action} className="mt-7 space-y-3">
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required className="field mt-1.5" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="field mt-1.5" />
        </div>
        {state?.error && (
          <p role="alert" className="rounded-lg border border-need/40 bg-need/10 px-3 py-2 text-sm text-need">
            {state.error}
          </p>
        )}
        <button className="btn-primary w-full" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-sm text-ink-mute">
        No account yet?{' '}
        <Link href="/signup" className="font-semibold text-white underline">
          Create one
        </Link>
      </p>
    </main>
  );
}
