import Link from 'next/link';
import { money } from '@/lib/pricing/quote';

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
  height = 'h-2',
}: {
  value: number;
  className?: string;
  tone?: 'have' | 'need' | 'gold';
  height?: string;
}) {
  const colors = { have: 'bg-have', need: 'bg-need', gold: 'bg-gold' } as const;
  const p = Math.max(0, Math.min(1, value));
  return (
    <div
      className={`${height} w-full overflow-hidden rounded-full bg-white/[.07] ${className}`}
      role="progressbar"
      aria-valuenow={Math.round(p * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={`h-full rounded-full ${colors[tone]} transition-[width] duration-700 ease-out`}
        style={{ width: `${p * 100}%` }}
      />
    </div>
  );
}

/**
 * Completion as a ring.
 *
 * A set is a fixed number of slots, and a ring says "how much of a whole" in a
 * way a bar does not. Pure SVG with no layout dependency, so it costs nothing
 * to render hundreds of them.
 */
export function Ring({
  value,
  size = 72,
  stroke = 6,
  tone = 'need',
  children,
  className = '',
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: 'have' | 'need' | 'gold';
  children?: React.ReactNode;
  className?: string;
}) {
  const p = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const colors = { have: '#2DD4A7', need: '#FF8A3D', gold: '#FFC93C' } as const;
  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuenow={Math.round(p * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={colors[tone]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - p)}
          style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.2,.8,.2,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        {children}
      </div>
    </div>
  );
}

/** A labelled figure. The unit of secondary metrics across the product. */
export function Stat({
  label,
  value,
  sub,
  tone = 'default',
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'default' | 'have' | 'need' | 'mute';
  className?: string;
}) {
  const toneClass =
    tone === 'have' ? 'text-have' : tone === 'need' ? 'text-need' : tone === 'mute' ? 'text-ink-mute' : '';
  return (
    <div className={className}>
      <p className="label">{label}</p>
      <p className={`num mt-1 text-[17px] font-bold leading-none ${toneClass}`}>{value}</p>
      {sub && <p className="mt-1 text-[11px] leading-tight text-ink-mute">{sub}</p>}
    </div>
  );
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
  return <p className={`text-[11px] leading-relaxed text-ink-mute ${className}`}>{children}</p>;
}

/**
 * Progressive disclosure for methodology.
 *
 * The commitment to explaining every number has not changed — what changed is
 * that the explanation no longer occupies the same visual weight as the number
 * it explains. A collector who wants the method is one tap away; one who wants
 * to hunt cards is not made to read it first.
 */
export function Disclosure({
  summary,
  children,
  className = '',
}: {
  summary: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={`group ${className}`}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium text-ink-mute transition hover:text-white [&::-webkit-details-marker]:hidden">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
          className="shrink-0 transition-transform group-open:rotate-90"
        >
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {summary}
      </summary>
      <div className="mt-2 text-[11px] leading-relaxed text-ink-mute">{children}</div>
    </details>
  );
}

/**
 * Price history, when there is history to show.
 *
 * Deliberately renders nothing below two readings: a single dated observation
 * is a price, not a trend, and a one-point chart implies a shape the data does
 * not have. The caller decides what to say in its place.
 */
export function Sparkline({
  points,
  width = 240,
  height = 48,
  className = '',
}: {
  points: { on: string; cents: number }[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) return null;

  const values = points.map((p) => p.cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 4;
  const step = (width - pad * 2) / (points.length - 1);
  const y = (c: number) => pad + (height - pad * 2) * (1 - (c - min) / span);

  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${pad + i * step},${y(p.cents)}`).join(' ');
  const area = `${d} L${pad + (points.length - 1) * step},${height - pad} L${pad},${height - pad} Z`;
  const rising = values[values.length - 1]! >= values[0]!;
  const tone = rising ? '#2DD4A7' : '#FF8A3D';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={`w-full ${className}`}
      role="img"
      aria-label={`Price from ${points[0]!.on} to ${points[points.length - 1]!.on}`}
      preserveAspectRatio="none"
    >
      <path d={area} fill={tone} opacity="0.12" />
      <path d={d} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pad + (points.length - 1) * step} cy={y(values[values.length - 1]!)} r="3" fill={tone} />
    </svg>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-xl ${className}`} aria-hidden />;
}

/** A row of card-shaped skeletons, for rails and grids that are still loading. */
export function CardSkeletons({ count = 6, width = 'w-[74px]' }: { count?: number; width?: string }) {
  return (
    <div className="flex gap-2" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`${width} shrink-0`}>
          <div className="skeleton card-art rounded-lg" />
        </div>
      ))}
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
  icon?: React.ReactNode;
}) {
  return (
    <div className="panel px-5 py-10 text-center">
      {icon && <div className="mb-3 flex justify-center text-ink-dim">{icon}</div>}
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
  className = '',
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-3 flex items-end justify-between gap-3 ${className}`}>
      <h2 className="label">{children}</h2>
      {action}
    </div>
  );
}

export { CardArt } from './CardArt';
