'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The shell, mobile-first and desktop-deliberate.
 *
 * On a phone the nav lives at the bottom, because SetValue is used standing up,
 * one-handed, with a binder in the other hand: every destination is inside
 * thumb reach and Card Show mode is the centre target.
 *
 * On a desktop none of that reasoning holds. A bottom bar on a 1440px display
 * is a phone control stranded at the foot of a large screen, and a 672px column
 * in the middle of that screen is a phone app someone forgot to lay out. So at
 * `lg` the navigation becomes a persistent left rail — always visible, no
 * thumb-reach constraint, room for labels — and the content takes the width
 * back. It is one component and one set of breakpoints, not a second
 * application.
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
      className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-line bg-ink/95 backdrop-blur-lg lg:hidden"
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

export function SideNav() {
  const path = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="sticky top-0 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-ink-line px-3 py-5 lg:flex"
    >
      <Link href="/app" className="px-3 pb-6 text-lg font-black tracking-tight">
        SET<span className="text-need">VALUE</span>
      </Link>
      <ul className="space-y-1">
        {TABS.map((t) => {
          const active = t.href === '/app' ? path === '/app' : path.startsWith(t.href);
          const Icon = t.icon;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition ${
                  active ? 'bg-white/[.07] text-white' : 'text-ink-mute hover:text-white'
                }`}
              >
                <span
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                    t.primary ? 'bg-need text-ink' : 'border border-ink-line'
                  }`}
                >
                  <Icon />
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto space-y-1 border-t border-ink-line pt-3">
        {[
          ['/app/binder', 'Binder'],
          ['/app/moves', 'Next Best Move'],
          ['/app/journey', 'Journey'],
          ['/app/profile', 'Profile'],
        ].map(([href, label]) => (
          <Link
            key={href}
            href={href}
            aria-current={path === href ? 'page' : undefined}
            className={`block rounded-lg px-3 py-2 text-[12px] font-semibold transition ${
              path === href ? 'text-white' : 'text-ink-mute hover:text-white'
            }`}
          >
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="lg:flex lg:items-start">
      <SideNav />
      <div className="mx-auto min-h-dvh w-full max-w-2xl pb-[calc(var(--nav-h)+1rem)] lg:mx-0 lg:max-w-none lg:flex-1 lg:pb-10">
        <div className="lg:mx-auto lg:max-w-[1180px] lg:px-6">{children}</div>
      </div>
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
    <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-ink-line bg-ink/95 px-4 py-3 backdrop-blur-lg">
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
