import Link from 'next/link';
import { requireUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { buildInsights } from '@/lib/services/insights';
import { demandForSpares } from '@/lib/services/demand';
import { TopBar } from '@/components/AppShell';
import { CardArt, Empty, SectionTitle, SourceNote } from '@/components/ui';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

export default async function TradePage() {
  const user = await requireUser();
  const db = getDb();

  const { trades, views } = buildInsights(db, user.id);
  const spares = demandForSpares(db, user.id);
  const mutual = trades.filter((t) => t.mutual);
  const oneWay = trades.filter((t) => !t.mutual);
  const wanted = spares.filter((s) => s.wantedBy > 0);

  return (
    <>
      <TopBar
        title="Trade"
        subtitle={`${trades.length} card${trades.length === 1 ? '' : 's'} you need are in other binders`}
      />
      <main className="space-y-6 px-4 pb-8 pt-4">
        {views.length === 0 ? (
          <Empty
            title="Track a set to find trades"
            body="Trade matching works by comparing what you are missing against copies other collectors have marked spare. It needs to know what you are chasing first."
            action={{ href: '/app/sets', label: 'Track a set' }}
          />
        ) : (
          <>
            <section>
              <SectionTitle>Both ways</SectionTitle>
              {mutual.length === 0 ? (
                <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
                  No two-way matches right now. These appear when another collector has a spare you
                  need <em>and</em> needs a spare you hold.
                </p>
              ) : (
                <ul className="space-y-2">
                  {mutual.map((t) => (
                    <li key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`} className="panel flex items-center gap-3 p-2.5">
                      <div className="w-[48px] shrink-0">
                        <CardArt src={t.imageSmall} alt={t.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{t.name}</p>
                        <p className="num truncate text-[11px] text-ink-mute">
                          #{t.number} · {VARIANT_LABEL[t.variant as Variant]}
                        </p>
                        <p className="mt-0.5 text-[11px] font-semibold text-have">
                          @{t.counterpartHandle} wants something you hold spare
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="num text-sm font-bold">{money(t.valueCents)}</p>
                        <Link
                          href={`/c/${t.counterpartHandle}`}
                          className="mt-1 inline-block rounded-full bg-white px-2.5 py-1 text-[10px] font-bold text-ink"
                        >
                          View binder
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {oneWay.length > 0 && (
              <section>
                <SectionTitle>They have what you need</SectionTitle>
                <ul className="space-y-2">
                  {oneWay.slice(0, 30).map((t) => (
                    <li key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`} className="panel flex items-center gap-3 p-2.5">
                      <div className="w-[48px] shrink-0">
                        <CardArt src={t.imageSmall} alt={t.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{t.name}</p>
                        <p className="num truncate text-[11px] text-ink-mute">
                          #{t.number} · @{t.counterpartHandle}
                        </p>
                      </div>
                      <p className="num shrink-0 text-sm font-bold">{money(t.valueCents)}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <section>
          <SectionTitle
            action={
              <Link href="/app/collection?view=duplicates" className="text-xs font-semibold text-ink-mute underline">
                Manage
              </Link>
            }
          >
            Demand for your spares
          </SectionTitle>
          {spares.length === 0 ? (
            <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
              You have no duplicate cards yet. Second copies show up here with a live count of how
              many collectors are missing them.
            </p>
          ) : (
            <ul className="space-y-2">
              {spares.slice(0, 30).map((s) => (
                <li key={s.itemId} className="panel flex items-center gap-3 p-2.5">
                  <div className="w-[48px] shrink-0">
                    <CardArt src={s.imageSmall} alt={s.name} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{s.name}</p>
                    <p className="num truncate text-[11px] text-ink-mute">
                      #{s.number} · {s.setName} · {s.spareCopies} spare
                    </p>
                    <p className={`text-[11px] font-semibold ${s.wantedBy > 0 ? 'text-have' : 'text-ink-mute'}`}>
                      {s.wantedBy > 0
                        ? `${s.wantedBy} collector${s.wantedBy === 1 ? '' : 's'} need${s.wantedBy === 1 ? 's' : ''} this`
                        : 'nobody tracking this one yet'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="num text-sm font-bold">{money(s.unitValueCents)}</p>
                    <p className="text-[10px] text-ink-mute">{s.forTrade ? 'listed' : 'not listed'}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <SourceNote className="mt-3">
            Demand counts are distinct collectors on SetValue who are missing that exact printing in
            a set they are actively chasing. Counts only — no collector identity is exposed by this
            list, and marking a card for trade is what makes it visible to a match.
          </SourceNote>
        </section>

        {wanted.length > 0 && (
          <p className="rounded-xl border border-gold/30 bg-gold/[0.07] px-3.5 py-3 text-xs leading-relaxed text-gold">
            {wanted.length} of your spare card{wanted.length === 1 ? '' : 's'} {wanted.length === 1 ? 'is' : 'are'}{' '}
            wanted by someone right now. Marking them for trade is the only step left.
          </p>
        )}
      </main>
    </>
  );
}
