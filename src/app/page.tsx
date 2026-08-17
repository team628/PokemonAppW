import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { money } from '@/lib/pricing/quote';

export const dynamic = 'force-dynamic';

export default async function Landing() {
  const user = await currentUser();
  if (user) redirect('/app');

  const db = getDb();
  const stats = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sets) AS sets,
         (SELECT COUNT(*) FROM cards) AS cards,
         (SELECT COUNT(*) FROM card_variants) AS slots,
         (SELECT COUNT(*) FROM card_variants v
            JOIN prices p ON p.card_id=v.card_id AND p.variant=v.variant AND p.provider='tcgplayer') AS priced,
         (SELECT MAX(observed_on) FROM prices WHERE provider='tcgplayer') AS newest`,
    )
    .get() as { sets: number; cards: number; slots: number; priced: number; newest: string | null };

  // A real, current example rather than a mock-up: the market value of Base Set
  // computed from the same tables the product runs on.
  const example = db
    .prepare(
      `SELECT SUM(COALESCE(p.market_cents, p.mid_cents, p.low_cents, 0)) AS cents, COUNT(*) AS n
       FROM cards c
       JOIN card_variants v ON v.card_id = c.id AND v.is_primary = 1
       LEFT JOIN prices p ON p.card_id=c.id AND p.variant=v.variant AND p.provider='tcgplayer'
       WHERE c.set_id = 'base1'`,
    )
    .get() as { cents: number; n: number };

  const coverage = (stats.priced / Math.max(1, stats.slots)) * 100;

  return (
    <main className="mx-auto w-full max-w-2xl px-5 pb-16">
      <header className="flex items-center justify-between py-5">
        <p className="text-lg font-black tracking-tight">
          SET<span className="text-need">VALUE</span>
        </p>
        <Link href="/signin" className="text-sm font-semibold text-ink-mute">
          Sign in
        </Link>
      </header>

      <section className="pt-8">
        <h1 className="text-[2.6rem] font-black leading-[1.05] tracking-tight">
          What you have.
          <br />
          What you <span className="text-need">need</span>.
          <br />
          What it&apos;s worth.
        </h1>
        <p className="mt-4 max-w-md text-[15px] leading-relaxed text-ink-mute">
          SetValue is the operating system for a Pokémon collection. It knows every card in every
          English set, what each one costs today, and exactly how far you are from finishing.
        </p>

        <div className="panel mt-7 px-5 py-5">
          <p className="label">Base Set · main set</p>
          <p className="num mt-1 text-4xl font-black text-need">{money(example.cents)}</p>
          <p className="mt-1 text-xs text-ink-mute">
            {example.n} cards at market, priced {stats.newest}. Own 60 of them and SetValue tells you
            what the other 42 cost — card by card, cheapest first.
          </p>
        </div>

        <div className="mt-5 flex gap-2">
          <Link href="/signup" className="btn-need flex-1">
            Start with one set
          </Link>
          <Link href="/signin" className="btn-ghost">
            Sign in
          </Link>
        </div>
      </section>

      <section className="mt-14">
        <h2 className="label">What it answers</h2>
        <ul className="mt-3 space-y-2">
          {[
            ['What do I have?', 'Every card, printing and condition, valued at current market.'],
            ['What do I need?', 'The exact missing cards for a main, complete or master set — with prices.'],
            ['What should I do next?', 'Ranked moves: the cheapest path to the biggest jump in completion.'],
            ['How do I finish?', 'A pull list sorted for digging, and Card Show mode for using it at a table.'],
            ['Who can help me?', 'Collectors holding spares of the cards you are missing.'],
          ].map(([q, a]) => (
            <li key={q} className="panel px-4 py-3.5">
              <p className="text-sm font-bold">{q}</p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-ink-mute">{a}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-14">
        <h2 className="label">Card Show mode</h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-mute">
          Standing at a table with a binder in one hand? Open the pull list for the set you are
          chasing, tap <span className="font-bold text-need">FOUND IT</span>, and watch the number
          fall. Finds are saved on the device when the hall wifi drops and sync themselves when it
          comes back.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="label">Built on real data</h2>
        <div className="panel mt-3 divide-y divide-ink-line">
          <Row label="Sets" value={stats.sets.toLocaleString()} />
          <Row label="Cards" value={stats.cards.toLocaleString()} />
          <Row label="Printings tracked" value={stats.slots.toLocaleString()} />
          <Row label="With a current market price" value={`${coverage.toFixed(1)}%`} />
          <Row label="Latest price reading" value={stats.newest ?? '—'} />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-ink-mute">
          Catalog from the PokemonTCG open dataset. Prices from TCGplayer and Cardmarket, carrying
          each provider&apos;s own observation date. Where SetValue estimates, it says estimate.
          Where it has no price, it shows a dash rather than a zero — and tells you your NEED total
          is a floor. Nothing here is invented.
        </p>
      </section>

      <footer className="mt-14 border-t border-ink-line pt-6 text-xs text-ink-mute">
        <p>
          SetValue is an independent tool for collectors. Not affiliated with, endorsed by, or
          sponsored by The Pokémon Company, Nintendo, Creatures Inc., GAME FREAK, TCGplayer or
          Cardmarket. Card images and names are property of their respective owners.
        </p>
        <p className="mt-3">
          <Link href="/partners" className="underline">
            For shops, marketplaces and partners
          </Link>
        </p>
      </footer>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-ink-mute">{label}</span>
      <span className="num text-xs font-semibold">{value}</span>
    </div>
  );
}
