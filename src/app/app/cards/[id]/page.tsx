import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getCard } from '@/lib/repo/catalog';
import { TopBar } from '@/components/AppShell';
import { SourceNote } from '@/components/ui';
import { money, euros, daysSince, STALE_AFTER_DAYS } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';
import { CardActions } from '@/components/CardActions';

export const dynamic = 'force-dynamic';

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const db = getDb();

  const card = getCard(db, id);
  if (!card) notFound();

  const variants = db
    .prepare('SELECT variant, source, is_primary FROM card_variants WHERE card_id = ? ORDER BY is_primary DESC, variant')
    .all(id) as { variant: Variant; source: string; is_primary: number }[];

  const prices = db
    .prepare('SELECT * FROM prices WHERE card_id = ?')
    .all(id) as {
    variant: string; provider: string; currency: string;
    low_cents: number | null; mid_cents: number | null; high_cents: number | null;
    market_cents: number | null; direct_cents: number | null; observed_on: string;
  }[];

  const owned = db
    .prepare(
      'SELECT variant, condition, SUM(quantity) AS qty FROM collection_items WHERE user_id = ? AND card_id = ? GROUP BY variant, condition',
    )
    .all(user.id, id) as { variant: string; condition: string; qty: number }[];
  const ownedByVariant = new Map<string, number>();
  for (const o of owned) ownedByVariant.set(o.variant, (ownedByVariant.get(o.variant) ?? 0) + o.qty);

  const history = db
    .prepare(
      `SELECT variant, observed_on, market_cents FROM price_points
       WHERE card_id = ? AND provider = 'tcgplayer' AND market_cents IS NOT NULL
       ORDER BY observed_on DESC LIMIT 40`,
    )
    .all(id) as { variant: string; observed_on: string; market_cents: number }[];
  const observationDates = [...new Set(history.map((h) => h.observed_on))];

  const goalsNeeding = db
    .prepare(
      `SELECT g.id, g.mode, s.name FROM set_goals g JOIN sets s ON s.id = g.set_id
       WHERE g.user_id = ? AND g.set_id = ?`,
    )
    .all(user.id, card.set_id) as { id: string; mode: string; name: string }[];

  return (
    <>
      <TopBar
        title={card.name}
        subtitle={`#${card.number} · ${card.set_name ?? card.set_id}`}
        back={`/app/sets/${card.set_id}`}
      />
      <main className="px-4 pb-8 pt-4">
        <div className="flex gap-4">
          <div className="w-[42%] shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={card.image_large ?? card.image_small ?? ''}
              alt={card.name}
              className="w-full rounded-xl"
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold leading-tight">{card.name}</h2>
            <p className="num mt-0.5 text-xs text-ink-mute">
              #{card.number}
              {card.printed_total ? `/${card.printed_total}` : ''} · {card.rarity ?? 'unknown rarity'}
            </p>
            {card.artist && <p className="mt-1 text-xs text-ink-mute">Illus. {card.artist}</p>}
            {card.is_secret === 1 && (
              <span className="chip mt-2 border-gold/40 text-gold">Secret rare</span>
            )}
            {card.flavor_text && (
              <p className="mt-3 border-l-2 border-ink-line pl-3 text-xs italic leading-relaxed text-ink-mute">
                {card.flavor_text}
              </p>
            )}
          </div>
        </div>

        <section className="mt-6">
          <h3 className="label mb-2">Printings &amp; market</h3>
          <ul className="space-y-2">
            {variants.map((v) => {
              const tcg = prices.find((p) => p.variant === v.variant && p.provider === 'tcgplayer');
              const cm = prices.find((p) => p.variant === v.variant && p.provider === 'cardmarket');
              const value = tcg?.market_cents ?? tcg?.mid_cents ?? tcg?.low_cents ?? null;
              const basis = tcg?.market_cents ? 'market' : tcg?.mid_cents ? 'mid listing' : tcg?.low_cents ? 'low listing' : null;
              const qty = ownedByVariant.get(v.variant) ?? 0;
              const stale = tcg ? daysSince(tcg.observed_on) > STALE_AFTER_DAYS : false;

              return (
                <li key={v.variant} className="panel px-3.5 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">
                        {VARIANT_LABEL[v.variant]}
                        {qty > 0 && <span className="ml-2 text-xs font-bold text-have">you own {qty}</span>}
                      </p>
                      <p className="mt-0.5 text-[11px] text-ink-mute">
                        {v.source === 'market_data'
                          ? 'Confirmed by market listings'
                          : 'Inferred from set era and rarity — no provider lists this printing separately'}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="num text-lg font-bold">{money(value)}</p>
                      {basis && (
                        <p className="text-[10px] text-ink-mute">
                          {basis} · {tcg!.observed_on}
                          {stale && <span className="text-gold"> · stale</span>}
                        </p>
                      )}
                    </div>
                  </div>

                  {tcg && (
                    <div className="num mt-2.5 grid grid-cols-4 gap-2 border-t border-ink-line pt-2.5 text-center text-[11px]">
                      <Figure label="Low" cents={tcg.low_cents} />
                      <Figure label="Mid" cents={tcg.mid_cents} />
                      <Figure label="High" cents={tcg.high_cents} />
                      <Figure label="Direct" cents={tcg.direct_cents} />
                    </div>
                  )}

                  {cm && (
                    <p className="mt-2 text-[11px] text-ink-mute">
                      Cardmarket (EU): trend {euros(cm.market_cents)} · low {euros(cm.low_cents)} ·
                      observed {cm.observed_on}. Shown for reference only — SetValue never converts
                      currencies without a rate source, so this figure is not part of any total.
                    </p>
                  )}

                  <CardActions
                    cardId={id}
                    variant={v.variant}
                    owned={qty}
                    setId={card.set_id}
                    mode={(goalsNeeding[0]?.mode as 'main' | 'complete' | 'master') ?? 'main'}
                  />
                </li>
              );
            })}
          </ul>
        </section>

        {goalsNeeding.length > 0 && (
          <section className="mt-6">
            <h3 className="label mb-2">Counts toward</h3>
            <ul className="flex flex-wrap gap-2">
              {goalsNeeding.map((g) => (
                <li key={g.id}>
                  <Link href={`/app/sets/${card.set_id}?mode=${g.mode}`} className="chip">
                    {g.name} · {g.mode}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <SourceNote className="mt-6 border-t border-ink-line pt-4">
          Prices come from TCGplayer (USD) and Cardmarket (EUR), republished by pokemontcg.io, with
          each provider&apos;s own observation date shown above.{' '}
          {observationDates.length < 2
            ? `SetValue holds ${observationDates.length} dated reading for this card, which is not enough to describe a trend — so it does not claim one.`
            : `SetValue holds ${observationDates.length} dated readings for this card, from ${observationDates[observationDates.length - 1]} to ${observationDates[0]}.`}
        </SourceNote>
      </main>
    </>
  );
}

function Figure({ label, cents }: { label: string; cents: number | null }) {
  return (
    <div>
      <p className="text-ink-mute">{label}</p>
      <p className="font-semibold">{cents === null ? '—' : money(cents)}</p>
    </div>
  );
}
