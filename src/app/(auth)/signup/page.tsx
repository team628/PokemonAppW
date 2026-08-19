'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { signUpAction } from '@/app/actions/auth';

export default function SignUpPage() {
  const [state, action, pending] = useActionState(signUpAction, null);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-5 py-10">
      <Link href="/" className="mb-8 text-lg font-black tracking-tight">
        SET<span className="text-need">VALUE</span>
      </Link>
      <h1 className="text-2xl font-bold">Start with one set</h1>
      <p className="mt-1 text-sm text-ink-mute">
        Pick a set you are chasing and SetValue tells you what it will take to finish it.
      </p>

      <form action={action} className="mt-7 space-y-3">
        <div>
          <label className="label" htmlFor="displayName">Name</label>
          <input id="displayName" name="displayName" autoComplete="name" required className="field mt-1.5" placeholder="Ash" />
        </div>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required className="field mt-1.5" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} className="field mt-1.5" />
          <p className="mt-1 text-[11px] text-ink-mute">At least 8 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="inviteCode">Invite code</label>
          <input id="inviteCode" name="inviteCode" autoComplete="off" autoCapitalize="characters" required className="field mt-1.5" placeholder="Your beta invite code" />
          <p className="mt-1 text-[11px] text-ink-mute">SetValue is in private beta — enter the code you were given.</p>
        </div>
        {state?.error && (
          <p role="alert" className="rounded-lg border border-need/40 bg-need/10 px-3 py-2 text-sm text-need">
            {state.error}
          </p>
        )}
        <button className="btn-primary w-full" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </button>
      </form>

      <p className="mt-6 text-sm text-ink-mute">
        Already collecting here?{' '}
        <Link href="/signin" className="font-semibold text-white underline">
          Sign in
        </Link>
      </p>
    </main>
  );
}
