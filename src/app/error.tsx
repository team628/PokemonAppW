'use client';

import Link from 'next/link';
import { useEffect } from 'react';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[setvalue] unhandled error:', error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 text-center">
      <p className="text-4xl" aria-hidden>🧩</p>
      <h1 className="mt-4 text-xl font-bold">Something broke on our side</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-mute">
        Your collection is safe — nothing was changed by this. This screen failed to load, not your
        data.
      </p>
      {error.digest && (
        <p className="num mt-3 text-[11px] text-ink-mute">Reference: {error.digest}</p>
      )}
      <div className="mt-6 grid grid-cols-2 gap-2">
        <button onClick={reset} className="btn-ghost">Try again</button>
        <Link href="/app" className="btn-primary">Go home</Link>
      </div>
    </main>
  );
}
