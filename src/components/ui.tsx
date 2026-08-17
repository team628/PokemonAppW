import Link from 'next/link';
import { money, pct } from '@/lib/pricing/quote';

export function Money({
  cents,
  className = '',
  approx = false,
}: {
  cents: number | null | undefined;
  className?: string;
  approx?: boolean;
}) {
  return (
    <span className={`num ${className}`}>
      {approx && cents !== null && cents !== undefined ? '~' : ''}
      {money(cents)}
    </span>
  );
}

export function Progress({
  value,
  className = '',
  tone = 'have',
}: {
  value: number;
  className?: string;
  tone?: 'have' | 'need' | 'gold';
}) {
  const colors = { have: 'bg-have', need: 'bg-need', gold: 'bg-gold' } as const;
  const p = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`h-2 w-full overflow-hidden rounded-full bg-white/10 ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(p * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full ${colors[tone]} transition-[width] duration-500`}
        style={{ width: `${p * 100}%` }}
      />
    </div>
  );
}

export function Pct({ value, digits = 1 }: { value: number; digits?: number }) {
  return <span className="num">{pct(value, digits)}</span>;
}

/**
 * Provenance chip. Wherever a number appears without an obvious source, this
 * component is how the collector finds out where it came from.
 */
export function SourceNote({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-[11px] leading-relaxed text-ink-mute ${className}`}>{children}</p>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="panel px-5 py-10 text-center">
      <p className="text-base font-semibold">{title}</p>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-mute">{body}</p>
      {action && (
        <Link href={action.href} className="btn-primary mt-5 inline-flex">
          {action.label}
        </Link>
      )}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="label">{children}</h2>
      {action}
    </div>
  );
}

export { CardArt } from './CardArt';

export function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'have' | 'need';
}) {
  const color = tone === 'have' ? 'text-have' : tone === 'need' ? 'text-need' : 'text-white';
  return (
    <div className="panel px-4 py-3">
      <p className="label">{label}</p>
      <p className={`num mt-1 text-xl font-bold ${color}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-ink-mute">{sub}</p>}
    </div>
  );
}
