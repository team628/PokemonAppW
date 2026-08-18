import { money } from '@/lib/pricing/quote';

/**
 * A finished set, as an object.
 *
 * This is the only place the completion of a set is *drawn*. The celebration
 * overlay renders it, the profile will render it, and a shareable completion
 * card — a public page, an image — renders the same component from the same
 * data. Keeping it pure and prop-driven is the whole point: the artefact a
 * collector shares must be the artefact they were shown the day they finished.
 *
 * Everything on it is a fact SetValue holds. There is no rank, no rarity score
 * and no "you are in the top N%", because none of those exist in the schema.
 */
export interface CompletionCardData {
  setId: string;
  setName: string;
  series: string | null;
  logoUrl: string | null;
  /** Printings required by the goal that was finished — not the printed total. */
  cardCount: number;
  mode: 'main' | 'complete' | 'master';
  /** ISO date. Null while a legacy goal has no recorded completion. */
  completedAt: string | null;
  /** Market value of the finished set on the day it was finished. */
  completeCents: number;
  /** Who finished it. Shown so the artefact means something out of context. */
  collector: string | null;
}

const MODE_LABEL: Record<CompletionCardData['mode'], string> = {
  main: 'Main set',
  complete: 'Complete set',
  master: 'Master set',
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function CompletionCard({
  data,
  className = '',
}: {
  data: CompletionCardData;
  className?: string;
}) {
  const finished = formatDate(data.completedAt);

  return (
    <article
      className={`relative overflow-hidden rounded-[20px] border border-gold/35 bg-ink-soft text-left shadow-lift ${className}`}
    >
      {/* A single warm wash from the top edge. The gold is SetValue's, not a
          borrowed holofoil effect. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-gold/[.16] via-gold/[.05] to-transparent"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[20px] ring-1 ring-inset ring-white/[.06]"
      />

      <div className="relative px-6 pb-6 pt-7">
        <p className="text-[10px] font-bold uppercase tracking-[.34em] text-gold">Set complete</p>

        <div className="mt-4 flex items-start gap-3.5">
          {data.logoUrl ? (
            // Deliberately not next/image: this component has to render
            // identically in a share surface with no image optimiser behind it.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.logoUrl}
              alt=""
              className="h-11 w-11 shrink-0 object-contain"
              loading="lazy"
            />
          ) : null}
          <div className="min-w-0">
            {data.series && (
              <p className="truncate text-[10px] uppercase tracking-[.2em] text-ink-mute">
                {data.series}
              </p>
            )}
            <h3 className="text-[26px] font-black leading-[1.06] tracking-tight">{data.setName}</h3>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-ink-line">
          <Cell label="Cards" value={data.cardCount.toLocaleString()} />
          <Cell label="Goal" value={MODE_LABEL[data.mode]} />
          <Cell label="Value" value={money(data.completeCents)} tone="text-have" />
        </div>

        <p className="mt-5 text-[12px] leading-relaxed text-ink-mute">
          {data.collector ? `${data.collector} completed ` : 'Completed '}
          every one of the {data.cardCount.toLocaleString()} printings in this{' '}
          {MODE_LABEL[data.mode].toLowerCase()}
          {finished ? ` on ${finished}` : ''}.
        </p>

        <p className="mt-4 border-t border-ink-line pt-3 text-[10px] font-bold uppercase tracking-[.22em] text-ink-dim">
          Set<span className="text-need">value</span>
        </p>
      </div>
    </article>
  );
}

function Cell({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-ink-soft px-3 py-2.5">
      <p className="label">{label}</p>
      <p className={`num mt-1 text-[15px] font-bold ${tone}`}>{value}</p>
    </div>
  );
}
