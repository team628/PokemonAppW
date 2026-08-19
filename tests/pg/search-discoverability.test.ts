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
});
