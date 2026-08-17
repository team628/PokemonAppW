import Link from 'next/link';
import { requireUser } from '@/lib/auth/session';
import { buildInsights } from '@/lib/services/pg';
import { withIdentity } from '@/lib/db/pg';
import { TopBar } from '@/components/AppShell';
import { CardArt } from '@/components/CardArt';
import { Empty, SectionTitle, SourceNote } from '@/components/ui';
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

  return (
    <>
      <TopBar title="Trade" subtitle={`${trades.length} card${trades.length === 1 ? '' : 's'} you need are in other binders`} />
      <main className="space-y-6 px-4 pb-8 pt-4">
        {goals.length === 0 ? (
          <Empty title="Track a set to find trades"
            body="Trade matching compares what you are missing against copies other collectors marked spare. It needs to know what you are chasing first."
            action={{ href: '/app/sets', label: 'Track a set' }} />
        ) : (
          <>
            <section>
              <SectionTitle action={allMutual.length > mutual.length
                ? <span className="num text-xs text-ink-mute">showing {mutual.length} of {allMutual.length}</span>
                : undefined}>Both ways</SectionTitle>
              {mutual.length === 0 ? (
                <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
                  No two-way matches right now. These appear when another collector has a spare you
                  need <em>and</em> needs a spare you hold.
                </p>
              ) : (
                <ul className="space-y-2">
                  {mutual.map((t) => (
                    <li key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`} className="panel flex items-center gap-3 p-2.5">
                      <div className="w-[48px] shrink-0"><CardArt src={t.imageSmall} alt={t.name} label={`#${t.number}`} /></div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{t.name}</p>
                        <p className="num truncate text-[11px] text-ink-mute">#{t.number} · {VARIANT_LABEL[t.variant as Variant]}</p>
                        <p className="mt-0.5 text-[11px] font-semibold text-have">@{t.counterpartHandle} wants something you hold spare</p>
                      </div>
                      <p className="num shrink-0 text-sm font-bold">{money(t.valueCents)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {oneWay.length > 0 && (
              <section>
                <SectionTitle action={allOneWay.length > oneWay.length
                  ? <span className="num text-xs text-ink-mute">showing {oneWay.length} of {allOneWay.length}</span>
                  : undefined}>They have what you need</SectionTitle>
                <ul className="space-y-2">
                  {oneWay.map((t) => (
                    <li key={`${t.cardId}-${t.variant}-${t.counterpartHandle}`} className="panel flex items-center gap-3 p-2.5">
                      <div className="w-[48px] shrink-0"><CardArt src={t.imageSmall} alt={t.name} label={`#${t.number}`} /></div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold">{t.name}</p>
                        <p className="num truncate text-[11px] text-ink-mute">#{t.number} · @{t.counterpartHandle}</p>
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
          <SectionTitle action={<Link href="/app/collection?view=duplicates" className="text-xs font-semibold text-ink-mute underline">Manage</Link>}>
            Demand for your spares
          </SectionTitle>
          {spares.length === 0 ? (
            <p className="panel px-4 py-6 text-center text-sm text-ink-mute">
              You have no duplicate cards yet. Second copies show up here with a live count of how
              many collectors are missing them.
            </p>
          ) : (
            <ul className="space-y-2">
              {spares.map((s) => (
                <li key={s.item_id} className="panel flex items-center gap-3 p-2.5">
                  <div className="w-[48px] shrink-0"><CardArt src={s.image_small} alt={s.name} label={`#${s.number}`} /></div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{s.name}</p>
                    <p className="num truncate text-[11px] text-ink-mute">#{s.number} · {s.set_name} · {s.spare_copies} spare</p>
                    <p className={`text-[11px] font-semibold ${s.wanted_by > 0 ? 'text-have' : 'text-ink-mute'}`}>
                      {s.wanted_by > 0
                        ? `${s.wanted_by} collector${s.wanted_by === 1 ? '' : 's'} need${s.wanted_by === 1 ? 's' : ''} this`
                        : 'nobody tracking this one yet'}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="num text-sm font-bold">{money(s.unit_value_cents)}</p>
                    <p className="text-[10px] text-ink-mute">{s.for_trade ? 'listed' : 'not listed'}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <SourceNote className="mt-3">
            Demand counts are distinct collectors missing that exact printing in a set they are
            actively chasing, read from the want index. Counts only — no collector identity is
            exposed, and marking a card for trade is what makes it visible to a match.
          </SourceNote>
        </section>

        {wanted.length > 0 && (
          <p className="rounded-xl border border-gold/30 bg-gold/[0.07] px-3.5 py-3 text-xs leading-relaxed text-gold">
            {wanted.length} of your spare card{wanted.length === 1 ? '' : 's'} {wanted.length === 1 ? 'is' : 'are'} wanted
            by someone right now. Marking them for trade is the only step left.
          </p>
        )}
      </main>
    </>
  );
}
