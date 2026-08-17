'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Mobile-first shell.
 *
 * The nav lives at the bottom because SetValue is used standing up, one-handed,
 * with a binder in the other hand. Every destination is inside thumb reach, and
 * the primary action (Card Show mode) is the centre target.
 */

const TABS = [
  { href: '/app', label: 'Home', icon: HomeIcon },
  { href: '/app/sets', label: 'Sets', icon: GridIcon },
  { href: '/app/show', label: 'Card Show', icon: BoltIcon, primary: true },
  { href: '/app/collection', label: 'Collection', icon: StackIcon },
  { href: '/app/trade', label: 'Trade', icon: SwapIcon },
];

export function BottomNav() {
  const path = usePathname();
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-line bg-ink/95 backdrop-blur"
      style={{ paddingBottom: 'var(--safe-b)' }}
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-2xl items-stretch">
        {TABS.map((t) => {
          const active = t.href === '/app' ? path === '/app' : path.startsWith(t.href);
          const Icon = t.icon;
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`flex min-h-[58px] flex-col items-center justify-center gap-1 text-[10px] font-semibold tracking-wide transition
                  ${active ? 'text-white' : 'text-ink-mute'}`}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-lg ${
                    t.primary ? 'bg-need text-ink' : ''
                  } ${active && !t.primary ? 'bg-white/10' : ''}`}
                >
                  <Icon />
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-2xl pb-24">
      {children}
      <BottomNav />
    </div>
  );
}

export function TopBar({
  title,
  subtitle,
  right,
  back,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  back?: string;
}) {
  return (
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-line bg-ink/95 px-4 py-3 backdrop-blur">
      {back && (
        <Link
          href={back}
          aria-label="Back"
          className="-ml-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ink-line text-ink-mute"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-bold leading-tight">{title}</h1>
        {subtitle && <p className="truncate text-[11px] text-ink-mute">{subtitle}</p>}
      </div>
      {right}
    </header>
  );
}

function HomeIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 10.5L12 3l9 7.5V20a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1v-9.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
function BoltIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor" />
    </svg>
  );
}
function StackIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3l9 5-9 5-9-5 9-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M3 13l9 5 9-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SwapIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
