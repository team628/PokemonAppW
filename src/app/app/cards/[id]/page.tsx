import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/session';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { Disclosure, Sparkline } from '@/components/ui';
import { money, euros, daysSince, STALE_AFTER_DAYS } from '@/lib/pricing/quote';
import { variantLabel } from '@/lib/catalog/variants';
import { CardActions } from '@/components/CardActions';
import { CardArt } from '@/components/CardArt';

export const dynamic = 'force-dynamic';

interface CardRow {
  id: string; set_id: string; set_name: string; printed_total: number; number: string;
  name: string; rarity: string | null; artist: string | null; flavor_text: string | null;
  image_small: string | null; image_large: string | null; is_secret: boolean;
}

interface PriceRow {
  variant: string; provider: string; currency: string;
  low_cents: number | null; mid_cents: number | null; high_cents: number | null;
  market_cents: number | null; direct_cents: number | null; observed_on: string;
}

export default async function CardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();

  const data = await withIdentity(user.id, async (tx) => {
    const card = await tx.one<CardRow>(
      `select c.id, c.set_id, s.name as set_name, s.printed_total, c.number, c.name, c.rarity,
              c.artist, c.flavor_text, c.image_small, c.image_large, c.is_secret
       from public.cards c join public.sets s on s.id = c.set_id
       where c.id = $1`,
      [id],
    );
    if (!card) return null;

    const [variants, prices, owned, history, goalsNeeding] = await Promise.all([
      tx.rows<{ variant: string; source: string; is_primary: boolean }>(
        `select variant, source::text, is_primary from public.card_variants
         where card_id = $1 order by is_primary desc, variant`,
        [id],
      ),
      tx.rows<PriceRow>(
        `select variant, provider, currency, low_cents, mid_cents, high_cents,
                market_cents, direct_cents, observed_on::text
         from public.prices where card_id = $1`,
        [id],
      ),
      tx.rows<{ variant: string; qty: number }>(
        `select variant, sum(quantity)::int as qty from public.collection_items
         where user_id = $1::uuid and card_id = $2 group by variant`,
        [user.id, id],
      ),
      // Every dated reading for this card, for the history chart.
      tx.rows<{ variant: string; observed_on: string; market_cents: number }>(
        `select variant, observed_on::text, market_cents from public.price_points
         where card_id = $1 and provider = 'tcgplayer' and market_cents is not null
         order by observed_on asc`,
        [id],
      ),
      tx.rows<{ id: string; mode: string; name: string }>(
        `select g.id, g.mode::text, s.name from public.set_goals g
         join public.sets s on s.id = g.set_id
         where g.user_id = $1::uuid and g.set_id = $2`,
        [user.id, id],
      ),
    ]);

    return { card, variants, prices, owned, history, goalsNeeding };
  });

  if (!data) notFound();
  const { card, variants, prices, owned, history, goalsNeeding } = data;

  const ownedByVariant = new Map<string, number>();
  for (const o of owned) ownedByVariant.set(o.variant, (ownedByVariant.get(o.variant) ?? 0) + o.qty);
  const totalOwned = [...ownedByVariant.values()].reduce((a, b) => a + b, 0);

  const primary = variants[0]?.variant ?? 'normal';
  const headline =
    prices.find((p) => p.variant === primary && p.provider === 'tcgplayer') ??
    prices.find((p) => p.provider === 'tcgplayer');
  const headlineCents =
    headline?.market_cents ?? headline?.mid_cents ?? headline?.low_cents ?? null;

  const series = history
    .filter((h) => h.variant === primary)
    .map((h) => ({ on: h.observed_on, cents: h.market_cents }));
  const change =
    series.length >= 2 ? series[series.length - 1]!.cents - series[0]!.cents : null;

  return (
    <>
      <TopBar
        title={card.name}
        subtitle={`#${card.number} · ${card.set_name}`}
        back={`/app/sets/${card.set_id}`}
      />
      {/* The card is the subject, so at `lg` it gets real size and stays put
          while the reader works down the numbers beside it. */}
      <main className="pb-8 lg:grid lg:grid-cols-[380px_minmax(0,1fr)] lg:items-start lg:gap-10 lg:pt-6">
        {/* ------------------------------------------------------- the card */}
        <section className="relative px-4 pt-4 lg:sticky lg:top-[76px] lg:px-0 lg:pt-0">
          <div className="mx-auto w-[62%] max-w-[260px] lg:w-full lg:max-w-none">
            <div className="overflow-hidden rounded-2xl shadow-lift">
              <CardArt
                src={card.image_large ?? card.image_small}
                alt={card.name}
                label={`#${card.number}`}
                priority
              />
            </div>
          </div>

          <div className="mt-5 text-center lg:text-left">
            <h2 className="text-xl font-extrabold leading-tight lg:text-2xl">{card.name}</h2>
            <p className="num mt-1 text-[11px] text-ink-mute">
              #{card.number}
              {card.printed_total ? `/${card.printed_total}` : ''} · {card.rarity ?? 'unknown rarity'}
              {card.is_secret && ' · secret'}
            </p>

            <p className="figure mt-3 text-[2.6rem]">
              {headlineCents === null ? <span className="text-ink-dim">—</span> : money(headlineCents)}
            </p>
            <p className="text-[10px] font-bold uppercase tracking-[.18em] text-ink-mute">
              {headlineCents === null ? 'No market price' : 'Market price'}
            </p>

            {totalOwned > 0 && (
              <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-have/15 px-3 py-1 text-[11px] font-bold text-have">
                In your collection · {totalOwned} cop{totalOwned === 1 ? 'y' : 'ies'}
              </p>
            )}
          </div>
        </section>

        <div className="min-w-0">
        {/* ---------------------------------------------------- price moves */}
        <section className="mt-6 px-4 lg:mt-0 lg:px-0">
          {series.length >= 2 ? (
            <div className="panel px-4 py-3.5">
              <div className="flex items-baseline justify-between">
                <p className="label">Price history</p>
                <p className={`num text-[12px] font-bold ${change! >= 0 ? 'text-have' : 'text-need'}`}>
                  {change! >= 0 ? '+' : '−'}
                  {money(Math.abs(change!))} since {series[0]!.on}
                </p>
              </div>
              <Sparkline points={series} className="mt-2 h-12" />
              <p className="num mt-1 flex justify-between text-[10px] text-ink-mute">
                <span>{series[0]!.on}</span>
                <span>
                  {series.length} readings · {series[series.length - 1]!.on}
                </span>
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-ink-mute">
              SetValue holds {series.length} dated reading{series.length === 1 ? '' : 's'} for this
              printing. A chart needs at least two, so there is nothing to plot yet — and one
              reading is not a trend.
            </p>
          )}
        </section>

        {/* ------------------------------------------------------- printings */}
        <section className="mt-6 px-4 lg:px-0">
          <h3 className="label mb-2">Printings you can own</h3>
          <ul className="space-y-2">
            {variants.map((v) => {
              const tcg = prices.find((p) => p.variant === v.variant && p.provider === 'tcgplayer');
              const cm = prices.find((p) => p.variant === v.variant && p.provider === 'cardmarket');
              const value = tcg?.market_cents ?? tcg?.mid_cents ?? tcg?.low_cents ?? null;
              const basis = tcg?.market_cents
                ? 'market'
                : tcg?.mid_cents
                  ? 'mid listing'
                  : tcg?.low_cents
                    ? 'low listing'
                    : null;
              const qty = ownedByVariant.get(v.variant) ?? 0;
              const stale = tcg ? daysSince(tcg.observed_on) > STALE_AFTER_DAYS : false;

              return (
                <li key={v.variant} className={`panel px-3.5 py-3 ${qty > 0 ? 'border-have/25' : ''}`}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold">
                        {variantLabel(v.variant)}
                        {qty > 0 && (
                          <span className="num ml-2 rounded-full bg-have/15 px-2 py-0.5 text-[10px] font-black text-have">
                            ×{qty}
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-[10px] text-ink-mute">
                        {v.source === 'market_data' ? 'Confirmed by listings' : 'Inferred printing'}
                        {stale && <span className="text-gold"> · price is stale</span>}
                      </p>
                    </div>
                    <p className="num shrink-0 text-[17px] font-bold">
                      {value === null ? <span className="text-ink-dim">—</span> : money(value)}
                    </p>
                  </div>

                  <CardActions
                    cardId={id}
                    variant={v.variant}
                    owned={qty}
                    setId={card.set_id}
                    mode={(goalsNeeding[0]?.mode as 'main' | 'complete' | 'master') ?? 'main'}
                  />

                  <Disclosure summary="Price detail" className="mt-2.5">
                    {tcg ? (
                      <>
                        TCGplayer {basis}, observed {tcg.observed_on}. Low {money(tcg.low_cents)} ·
                        mid {money(tcg.mid_cents)} · high {money(tcg.high_cents)}
                        {tcg.direct_cents !== null && <> · direct {money(tcg.direct_cents)}</>}.
                      </>
                    ) : (
                      'No TCGplayer listing for this printing.'
                    )}
                    {cm && (
                      <>
                        {' '}
                        Cardmarket (EU) trend {euros(cm.market_cents)}, observed {cm.observed_on} —
                        shown for reference only. SetValue never converts currencies without a rate
                        source, so this is not part of any total.
                      </>
                    )}
                    {v.source === 'inferred' &&
                      ' This printing is derived from the set’s era and rarity because no price provider lists it separately.'}
                  </Disclosure>
                </li>
              );
            })}
          </ul>
        </section>

        {goalsNeeding.length > 0 && (
          <section className="mt-6 px-4 lg:px-0">
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

        {(card.artist || card.flavor_text) && (
          <section className="mt-6 px-4 lg:px-0">
            <Disclosure summary="About this card">
              {card.artist && <>Illustrated by {card.artist}. </>}
              {card.flavor_text}
            </Disclosure>
          </section>
        )}
        </div>
      </main>
    </>
  );
}
