import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { buildInsights } from '@/lib/services/pg';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { CardArt } from '@/components/CardArt';
import { Disclosure, Empty, Money, SectionTitle } from '@/components/ui';
import { money } from '@/lib/pricing/quote';
import { VARIANT_LABEL, type Variant } from '@/lib/catalog/variants';

export const dynamic = 'force-dynamic';

/** Both lists are capped: rendering every match produced a 19 MB page at scale. */
const LIST_CAP = 40;

export default async function TradePage() {
  const user = await requireUser();
  const [{ trades, goals }, spares] = await Promise.all([
    buildInsights(user.id),
    withIdentity(user.id, (tx) =>
      tx.rows<{
        item_id: string; card_id: string; name: string; number: string; set_name: string;
        variant: string; image_small: string | null; spare_copies: number;
        unit_value_cents: number | null; for_trade: boolean; wanted_by: number;
      }>('select * from public.my_spare_demand(50)'),
    ),
  ]);

  const allMutual = trades.filter((t) => t.mutual);
  const allOneWay = trades.filter((t) => !t.mutual);
  const mutual = allMutual.slice(0, LIST_CAP);
  const oneWay = allOneWay.slice(0, LIST_CAP);
  const wanted = spares.filter((s) => s.wanted_by > 0);
  const unlisted = wanted.filter((s) => !s.for_trade);

  return (
    <>
      <TopBar
        title="Trade"
        subtitle={
          trades.length
            ? `${allMutual.length} two-way · ${allOneWay.length} one-way`
            : 'No matches yet'
        }
      />
      <main className="space-y-6 px-4 pb-8 pt-4">
        {goals.length === 0 ? (
          <Empty
            title="Track a set to find trades"
            body="Trade matching compares what you are missing against copies other collectors marked spare. It needs to know what you are chasing first."
            action={{ href: '/app/sets', label: 'Track a set' }}
          />
        ) : (
          <>
            <section>
              <SectionTitle
                action={
                  allMutual.length > mutual.length ? (
                    <span className="num text-[11px] text-ink-mute">
                      {mutual.length} of {allMutual.length}
                    </span>
                  ) : undefined
                }
              >
                Both ways
              </SectionTitle>
              {mutual.length === 0 ? (
                <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
                  No two-way matches right now. These appear when another collector has a spare you
                  need <em>and</em> needs a spare you hold.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {mutual.map((t) => (
                    <li
                      key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`}
                      className="panel overflow-hidden"
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-ink-line px-3.5 py-2">
                        <p className="truncate text-[11px] font-semibold text-have">
                          @{t.counterpartHandle}
                        </p>
                        <span className="chip border-have/40 text-have">Two-way</span>
                      </div>

                      <div className="flex items-stretch">
                        {/* What they have that you need */}
                        <div className="flex min-w-0 flex-1 items-center gap-2.5 p-3">
                          <div className="w-[46px] shrink-0">
                            <CardArt src={t.imageSmall} alt={t.name} />
                          </div>
                          <div className="min-w-0">
                            <p className="label">You get</p>
                            <p className="truncate text-[12px] font-bold leading-tight">{t.name}</p>
                            <p className="num truncate text-[10px] text-ink-mute">
                              #{t.number} · {VARIANT_LABEL[t.variant as Variant]}
                            </p>
                            <Money cents={t.valueCents} className="text-[12px] font-bold text-need" />
                          </div>
                        </div>

                        <div
                          aria-hidden
                          className="flex w-7 shrink-0 items-center justify-center border-x border-ink-line text-ink-dim"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </div>

                        {/* What you have that they need */}
                        <div className="flex min-w-0 flex-1 items-center gap-2.5 p-3">
                          {t.theirs ? (
                            <>
                              <div className="w-[46px] shrink-0">
                                <CardArt src={t.theirs.imageSmall} alt={t.theirs.name} />
                              </div>
                              <div className="min-w-0">
                                <p className="label">You give</p>
                                <p className="truncate text-[12px] font-bold leading-tight">
                                  {t.theirs.name}
                                </p>
                                <p className="num truncate text-[10px] text-ink-mute">
                                  #{t.theirs.number} · your spare
                                </p>
                                <Money
                                  cents={t.theirs.valueCents}
                                  className="text-[12px] font-bold text-have"
                                />
                              </div>
                            </>
                          ) : (
                            <p className="text-[11px] text-ink-mute">
                              They need something you hold spare.
                            </p>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {oneWay.length > 0 && (
              <section>
                <SectionTitle
                  action={
                    allOneWay.length > oneWay.length ? (
                      <span className="num text-[11px] text-ink-mute">
                        {oneWay.length} of {allOneWay.length}
                      </span>
                    ) : undefined
                  }
                >
                  They have what you need
                </SectionTitle>
                <ul className="space-y-2">
                  {oneWay.map((t) => (
                    <li
                      key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`}
                      className="panel flex items-center gap-3 p-2.5"
                    >
                      <div className="w-[46px] shrink-0">
                        <CardArt src={t.imageSmall} alt={t.name} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold">{t.name}</p>
                        <p className="num truncate text-[10px] text-ink-mute">
                          #{t.number} · @{t.counterpartHandle} · {t.spareCopies} spare
                        </p>
                      </div>
                      <Money cents={t.valueCents} className="shrink-0 text-[13px] font-bold" />
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
              <Link
                href="/app/collection?view=duplicates"
                className="text-[11px] font-semibold text-ink-mute underline underline-offset-2"
              >
                Manage
              </Link>
            }
          >
            Demand for your spares
          </SectionTitle>

          {unlisted.length > 0 && (
            <p className="mb-2.5 rounded-xl border border-gold/30 bg-gold/[0.07] px-3.5 py-2.5 text-[12px] leading-relaxed text-gold">
              {unlisted.length} spare{unlisted.length === 1 ? '' : 's'} you hold{' '}
              {unlisted.length === 1 ? 'is' : 'are'} wanted right now but not listed. Marking them
              for trade is the only step left.
            </p>
          )}

          {spares.length === 0 ? (
            <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
              You have no duplicate cards yet. Second copies show up here with a live count of how
              many collectors are missing them.
            </p>
          ) : (
            <ul className="space-y-2">
              {spares.map((s) => (
                <li key={s.item_id} className="panel flex items-center gap-3 p-2.5">
                  <div className="w-[46px] shrink-0">
                    <CardArt src={s.image_small} alt={s.name} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">{s.name}</p>
                    <p className="num truncate text-[10px] text-ink-mute">
                      #{s.number} · {s.set_name} · {s.spare_copies} spare
                    </p>
                    <p
                      className={`text-[11px] font-semibold ${
                        s.wanted_by > 0 ? 'text-have' : 'text-ink-mute'
                      }`}
                    >
                      {s.wanted_by > 0
                        ? `${s.wanted_by} collector${s.wanted_by === 1 ? '' : 's'} need${
                            s.wanted_by === 1 ? 's' : ''
                          } this`
                        : 'nobody tracking this one yet'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money cents={s.unit_value_cents} className="block text-[13px] font-bold" />
                    <p className="text-[10px] text-ink-mute">
                      {s.for_trade ? 'listed' : 'not listed'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <Disclosure summary="How matching works, and what it never shows" className="mt-3">
            Demand counts are distinct collectors missing that exact printing in a set they are
            actively chasing, read from the want index. Matching only ever considers cards their
            owner explicitly marked for trade, and it is narrowed to printings you are personally
            missing. No user ids, conditions, purchase prices or unlisted cards cross between
            collectors — marking a card for trade is what makes it visible at all.
          </Disclosure>
        </section>
      </main>
    </>
  );
}
