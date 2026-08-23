import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 text-center">
      <p className="text-4xl" aria-hidden>🔍</p>
      <h1 className="mt-4 text-xl font-bold">Not found</h1>
      <p className="mt-2 text-sm leading-relaxed text-ink-mute">
        That card, set or collector page does not exist — or the collection is private.
      </p>
      <div className="mt-6 grid grid-cols-2 gap-2">
        <Link href="/app/sets" className="btn-ghost">Browse sets</Link>
        <Link href="/app" className="btn-primary">Go home</Link>
      </div>
    </main>
  );
}
