import { afterAll, describe, expect, it } from 'vitest';
import { withIdentity, closePool } from '@/lib/db/pg';
import { searchCards } from '@/lib/services/pg';

/**
 * Collector-search discoverability (migration 0019).
 *
 * The named cards below all EXIST in the catalog; the old prefix-only, name-only
 * search could not surface them under the words a collector types. These are the
 * regression queries signed off for this pass — each asserts, at the NAME level
 * ("a search for Charizard must return Charizard, Mega Charizard, M Charizard-EX,
 * Dark/Shining/Radiant/Blaine's Charizard …"), that the relevant cards are
 * discoverable. Runs through the anonymous role, exactly as the app's search does.
 */

afterAll(async () => {
  await closePool();
});

type Hit = { id: string; name: string; set_id: string };

const search = (q: string, setId?: string) =>
  searchCards(null, q, setId) as Promise<Hit[]>;

// Apostrophe / dash / glyph / spacing-insensitive name containment.
const norm = (s: string) =>
  s.toLowerCase().replace(/[’'`-]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const hasName = (rows: Hit[], wanted: string) =>
  rows.some((r) => norm(r.name).includes(norm(wanted)));

describe('collector search — required regression queries', () => {
  const CASES: Array<[string, string[]]> = [
    ['Charizard', ['Charizard', 'Mega Charizard', 'M Charizard-EX', 'Dark Charizard',
                   'Shining Charizard', 'Radiant Charizard', "Blaine's Charizard", 'Reshiram & Charizard']],
    ['Mega Charizard', ['M Charizard-EX', 'Mega Charizard X', 'Mega Charizard Y']],
    ['M Charizard EX', ['M Charizard-EX']],
    ['Gold Star Charizard', ['Charizard ★']],
    ['Charizard Gold Star', ['Charizard ★']],
    ['Delta Charizard', ['Charizard δ']],
    ['Shining Charizard', ['Shining Charizard']],
    ['Dark Charizard', ['Dark Charizard']],
    ['Blaines Charizard', ["Blaine's Charizard"]],
    ['Snorlax LVX', ['Snorlax LV.X']],
    ['Nidoran female', ['Nidoran ♀']],
    ['SWSH284', ['Galarian Moltres']],
  ];

  for (const [query, names] of CASES) {
    it(`"${query}" surfaces ${names.length} expected name(s)`, async () => {
      const rows = await search(query);
      const missing = names.filter((n) => !hasName(rows, n));
      expect(missing, `missing from results: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('"Phantasmal Flames Charizard" finds the Mega Charizard in set me2', async () => {
    const rows = await search('Phantasmal Flames Charizard');
    expect(rows.some((r) => r.set_id === 'me2' && norm(r.name).includes('mega charizard'))).toBe(true);
  });

  it('exact name stays ranked first', async () => {
    const rows = await search('Blastoise');
    expect(norm(rows[0]!.name)).toBe('blastoise');
  });

  it('keeps a collector’s specific alternate printings visible, not collapsed away', async () => {
    const rows = await search('Mega Charizard');
    const ids = new Set(rows.map((r) => r.id));
    // All four "Mega Charizard X ex" printings in Phantasmal Flames.
    for (const id of ['me2-13', 'me2-109', 'me2-125', 'me2-130']) expect(ids.has(id)).toBe(true);
  });

  it('searches card numbers across sets without a set filter', async () => {
    const rows = await search('SWSH075'); // Special Delivery Charizard promo number
    expect(rows.some((r) => r.id === 'swshp-SWSH075')).toBe(true);
  });

  it('is apostrophe-insensitive', async () => {
    const withApos = await search("Blaine's Charizard");
    const without = await search('Blaines Charizard');
    expect(hasName(withApos, "Blaine's Charizard")).toBe(true);
    expect(hasName(without, "Blaine's Charizard")).toBe(true);
  });

  it('tolerates a typo via fuzzy matching', async () => {
    const rows = await search('Charzard'); // missing the i
    expect(hasName(rows, 'Charizard')).toBe(true);
  });

  it('returns nothing for an empty query', async () => {
    expect(await search('   ')).toEqual([]);
  });

  // Tranche 1: SVP promos re-synced from live pokemontcg.io (svp 165 -> 200).
  // The catalog mirror is fetched (data/raw is gitignored) and upstream may lag,
  // so this asserts discoverability *when* the promos are present — the Tranche-1
  // guarantee — and is inert against a stale snapshot rather than failing it.
  it('makes the re-synced SVP promos discoverable by name and promo number when present', async () => {
    const [{ present }] = await withIdentity(null, (tx) =>
      tx.rows<{ present: boolean }>("select exists(select 1 from public.cards where id = 'svp-207') as present"),
    );
    if (!present) return; // upstream snapshot predates the SVP re-sync; nothing to assert
    expect(hasName(await search('Bloodmoon Ursaluna ex'), 'Bloodmoon Ursaluna ex')).toBe(true);
    expect((await search('SVP 207')).some((r) => r.id === 'svp-207')).toBe(true);
    expect((await search('svp166')).some((r) => r.id === 'svp-166')).toBe(true);
  });

  // Tranche 2A: TCGplayer-derived (TCGCSV) promos pokemontcg.io lacks — MEP set +
  // SVP tail. Presence-guarded, since these are ingested via a deploy script, not
  // the fetched pokemontcg mirror.
  it('makes the Tranche-2A MEP / SVP-tail promos discoverable by name and promo number when present', async () => {
    const [{ present }] = await withIdentity(null, (tx) =>
      tx.rows<{ present: boolean }>("select exists(select 1 from public.cards where id = 'mep-1') as present"),
    );
    if (!present) return;
    expect((await search('MEP 009')).some((r) => r.id === 'mep-9')).toBe(true);
    expect((await search('mep001')).some((r) => r.id === 'mep-1')).toBe(true);
    expect((await search('SVP 210')).some((r) => r.id === 'svp-210')).toBe(true);
    // provenance: these are TCGplayer-derived, never labelled pokemontcg
    const [{ prov }] = await withIdentity(null, (tx) =>
      tx.rows<{ prov: string }>("select provider as prov from public.cards where id = 'mep-1'"),
    );
    expect(prov).toBe('tcgcsv');

    // 2A name-precision supplement: Mega Charizard X/Y ex (TCGplayer's precise names)
    const [{ hasSupp }] = await withIdentity(null, (tx) =>
      tx.rows<{ hasSupp: boolean }>("select exists(select 1 from public.cards where id = 'mep-30') as \"hasSupp\""),
    );
    if (hasSupp) {
      expect((await search('MEP 023')).some((r) => r.id === 'mep-23')).toBe(true);
      expect(hasName(await search('Mega Charizard Y ex'), 'Mega Charizard Y ex')).toBe(true);
    }
  });
});
