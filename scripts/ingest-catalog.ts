/**
 * Loads sets + cards from data/raw into SQLite.
 *
 * Source: PokemonTCG/pokemon-tcg-data (the dataset behind api.pokemontcg.io),
 * downloaded by scripts/fetch-catalog.mjs. Idempotent — safe to re-run.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, nowIso } from '../src/lib/db/index';

interface RawSet {
  id: string;
  name: string;
  series: string;
  printedTotal: number;
  total: number;
  ptcgoCode?: string;
  releaseDate?: string;
  updatedAt?: string;
  images?: { symbol?: string; logo?: string };
}

interface RawCard {
  id: string;
  name: string;
  number: string;
  supertype?: string;
  subtypes?: string[];
  rarity?: string;
  artist?: string;
  hp?: string;
  types?: string[];
  nationalPokedexNumbers?: number[];
  flavorText?: string;
  images?: { small?: string; large?: string };
}

/** '4a' -> {n: 4, suffix: 'a'};  'SWSH001' -> {n: 1, suffix: ''};  'TG05' -> {n: 5, suffix: ''} */
export function parseNumber(raw: string): { n: number; suffix: string } {
  const m = raw.match(/^([A-Za-z]*)(\d+)(.*)$/);
  if (!m) return { n: 999999, suffix: raw };
  const prefix = m[1] ?? '';
  const n = parseInt(m[2]!, 10);
  const tail = (m[3] ?? '').trim();
  // Prefixed subsets (TG, GG, SV, RC…) sort after the main run.
  const offset = prefix ? 100000 + prefix.charCodeAt(0) * 100 : 0;
  return { n: n + offset, suffix: tail };
}

const RAW = path.join(process.cwd(), 'data', 'raw');

function main() {
  const db = openDb();
  const started = nowIso();

  const sets: RawSet[] = JSON.parse(readFileSync(path.join(RAW, 'sets.json'), 'utf8'));

  const insSet = db.prepare(`
    INSERT INTO sets (id, name, series, printed_total, total, ptcgo_code, release_date, symbol_url, logo_url, updated_at)
    VALUES (@id, @name, @series, @printed_total, @total, @ptcgo_code, @release_date, @symbol_url, @logo_url, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, series=excluded.series, printed_total=excluded.printed_total,
      total=excluded.total, ptcgo_code=excluded.ptcgo_code, release_date=excluded.release_date,
      symbol_url=excluded.symbol_url, logo_url=excluded.logo_url, updated_at=excluded.updated_at`);

  const insCard = db.prepare(`
    INSERT INTO cards (id, set_id, number, number_sort, number_suffix, name, supertype, subtypes,
                       rarity, artist, hp, types, national_dex, flavor_text, image_small, image_large, is_secret)
    VALUES (@id, @set_id, @number, @number_sort, @number_suffix, @name, @supertype, @subtypes,
            @rarity, @artist, @hp, @types, @national_dex, @flavor_text, @image_small, @image_large, @is_secret)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, number=excluded.number, number_sort=excluded.number_sort,
      number_suffix=excluded.number_suffix, rarity=excluded.rarity, artist=excluded.artist,
      image_small=excluded.image_small, image_large=excluded.image_large, is_secret=excluded.is_secret`);

  let cardCount = 0;

  db.transaction(() => {
    for (const s of sets) {
      insSet.run({
        id: s.id,
        name: s.name,
        series: s.series,
        printed_total: s.printedTotal ?? 0,
        total: s.total ?? 0,
        ptcgo_code: s.ptcgoCode ?? null,
        release_date: s.releaseDate ?? null,
        symbol_url: s.images?.symbol ?? null,
        logo_url: s.images?.logo ?? null,
        updated_at: s.updatedAt ?? null,
      });
    }

    for (const file of readdirSync(path.join(RAW, 'cards'))) {
      if (!file.endsWith('.json')) continue;
      const setId = file.replace(/\.json$/, '');
      const set = sets.find((s) => s.id === setId);
      if (!set) continue;
      const cards: RawCard[] = JSON.parse(readFileSync(path.join(RAW, 'cards', file), 'utf8'));
      for (const c of cards) {
        const { n, suffix } = parseNumber(c.number);
        insCard.run({
          id: c.id,
          set_id: setId,
          number: c.number,
          number_sort: n,
          number_suffix: suffix,
          name: c.name,
          supertype: c.supertype ?? null,
          subtypes: JSON.stringify(c.subtypes ?? []),
          rarity: c.rarity ?? null,
          artist: c.artist ?? null,
          hp: c.hp ?? null,
          types: JSON.stringify(c.types ?? []),
          national_dex: JSON.stringify(c.nationalPokedexNumbers ?? []),
          flavor_text: c.flavorText ?? null,
          image_small: c.images?.small ?? null,
          image_large: c.images?.large ?? null,
          is_secret: n > (set.printedTotal ?? 0) && n < 100000 ? 1 : 0,
        });
        cardCount++;
      }
    }
  })();

  db.prepare(
    `INSERT INTO ingest_runs (kind, source, started_at, finished_at, rows, notes)
     VALUES ('catalog', 'PokemonTCG/pokemon-tcg-data', ?, ?, ?, ?)`,
  ).run(started, nowIso(), cardCount, `${sets.length} sets`);

  console.log(`catalog: ${sets.length} sets, ${cardCount} cards`);
  db.close();
}

if (process.argv[1]?.includes('ingest-catalog')) main();
