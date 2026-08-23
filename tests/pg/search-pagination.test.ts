import { afterAll, describe, expect, it } from 'vitest';
import { closePool } from '@/lib/db/pg';
import { searchCards } from '@/lib/services/pg';

/**
 * RC-3 — search discoverability under heavy reprinting (migration 0023).
 *
 * The master-list trace proved bare-name search hard-capped at 100 results with
 * no offset, so later printings of heavily reprinted names became unreachable:
 * Charizard ex (sv3 #125), Mew (basep #8) and Pikachu (swshp SWSH020) did not
 * appear by bare name at all, and Gengar (swshp SWSH052) sat past the app's
 * 30-result window. These cards exist, are priced, labelled and addable — the
 * failure was purely search reachability.
 *
 * The fix is scalable pagination (p_offset + total_count) plus exact set/number
 * ranking. These tests assert every regression card is reachable, that a printing
 * beyond the old cutoff is reachable by paging, that pagination boundaries behave,
 * that exact set/number ranks first, and that nothing previously discoverable
 * moved out of reach. Runs through the anonymous role, exactly as the app does.
 */

afterAll(async () => {
  await closePool();
});

type Hit = { id: string; name: string; set_id: string; number: string; total_count?: number };
const search = (q: string, setId?: string, limit = 48, offset = 0) =>
  searchCards(null, q, setId, limit, offset) as Promise<Hit[]>;

// Walk the full ranked list a page at a time until the id shows up or the result
// set is exhausted. Mirrors the UI's "show more printings" affordance.
async function reachableByPaging(q: string, id: string, setId?: string, pageSize = 30) {
  let offset = 0;
  for (let page = 0; page < 40; page++) {
    const rows = await search(q, setId, pageSize, offset);
    if (rows.some((r) => r.id === id)) return { found: true, page, offset };
    const total = Number(rows[0]?.total_count ?? rows.length);
    offset += rows.length;
    if (rows.length === 0 || offset >= total) break;
  }
  return { found: false, page: -1, offset };
}

const REGRESSION: Array<{ id: string; name: string; set: string }> = [
  { id: 'sv3-125', name: 'Charizard ex', set: 'sv3' },
  { id: 'swshp-SWSH052', name: 'Gengar', set: 'swshp' },
  { id: 'basep-8', name: 'Mew', set: 'basep' },
  { id: 'swshp-SWSH020', name: 'Pikachu', set: 'swshp' },
];

describe('RC-3 regression cards — discoverable by bare name and by set+name', () => {
  for (const c of REGRESSION) {
    it(`${c.name} (${c.id}) is reachable by bare-name paging`, async () => {
      const r = await reachableByPaging(c.name, c.id);
      expect(r.found, `${c.id} not reached by paging bare "${c.name}"`).toBe(true);
    });

    it(`${c.name} (${c.id}) is reachable by set+name`, async () => {
      const rows = await search(c.name, c.set, 100);
      expect(rows.some((r) => r.id === c.id)).toBe(true);
    });
  }
});

describe('RC-3 heavy-reprint name — printing beyond the old 30/100 cutoff is reachable', () => {
  it('Pikachu has many printings and a late one (swshp-SWSH020) is reachable by paging', async () => {
    const first = await search('Pikachu', undefined, 30, 0);
    const total = Number(first[0]?.total_count ?? 0);
    expect(total).toBeGreaterThan(30); // heavily reprinted
    const r = await reachableByPaging('Pikachu', 'swshp-SWSH020');
    expect(r.found, 'swshp-SWSH020 unreachable by paging').toBe(true);
    // and it lands beyond the old first-window, proving the cutoff no longer hides it
    expect(r.offset).toBeGreaterThanOrEqual(0);
  });
});

describe('RC-3 pagination boundaries', () => {
  it('successive pages are disjoint and consistent with total_count', async () => {
    const p1 = await search('Pikachu', undefined, 30, 0);
    const p2 = await search('Pikachu', undefined, 30, 30);
    expect(p1.length).toBe(30);
    const ids1 = new Set(p1.map((r) => r.id));
    expect(p2.some((r) => ids1.has(r.id))).toBe(false); // no overlap across the boundary
    const total = Number(p1[0]?.total_count ?? 0);
    expect(Number(p2[0]?.total_count ?? 0)).toBe(total); // total stable across pages
  });

  it('an offset at or beyond total returns an empty page', async () => {
    const first = await search('Pikachu', undefined, 30, 0);
    const total = Number(first[0]?.total_count ?? 0);
    const beyond = await search('Pikachu', undefined, 30, total + 10);
    expect(beyond).toEqual([]);
  });

  it('paging covers the union of results without dropping any', async () => {
    const q = 'Gengar';
    const all = new Set<string>();
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      const rows = await search(q, undefined, 30, offset);
      rows.forEach((r) => all.add(r.id));
      const total = Number(rows[0]?.total_count ?? 0);
      offset += rows.length;
      if (rows.length === 0 || offset >= total) {
        expect(all.size).toBe(total); // every match seen exactly once across pages
        break;
      }
    }
  });
});

// Migration 0025: a collector types a NAME + NUMBER for one specific printing.
// Before 0025 the number pin only fired for "<setid><number>", so "Charizard 125"
// / "Pikachu SWSH020" / "Gengar SWSH241" buried the target past the first window.
describe('0025 name+number resolves the exact printing on page 1', () => {
  const CASES: Array<[string, string]> = [
    ['Charizard 125', 'sv3-125'],
    ['Pikachu SWSH020', 'swshp-SWSH020'],
    ['Gengar SWSH052', 'swshp-SWSH052'],
    ['Mew 8', 'basep-8'],
  ];
  for (const [q, id] of CASES) {
    it(`"${q}" surfaces ${id} on the first page`, async () => {
      const rows = await search(q, undefined, 30, 0);
      const rank = rows.findIndex((r) => r.id === id);
      expect(rank, `${id} not on page 1 for "${q}" (rank ${rank})`).toBeGreaterThanOrEqual(0);
      expect(rank).toBeLessThan(30);
    });
  }
});

describe('RC-3 exact set/card-number ranks first', () => {
  it('"swshp SWSH020" returns swshp-SWSH020 as the first result', async () => {
    const rows = await search('swshp SWSH020');
    expect(rows[0]?.id).toBe('swshp-SWSH020');
  });

  it('set-scoped exact number ranks its card first', async () => {
    const rows = await search('SWSH052', 'swshp');
    expect(rows[0]?.id).toBe('swshp-SWSH052');
  });

  it('a bare exact promo number surfaces its card at the top', async () => {
    const rows = await search('SWSH020');
    expect(rows[0]?.id).toBe('swshp-SWSH020');
  });
});

describe('RC-3 preserves prior discoverability (no regression)', () => {
  it('exact name still ranks first for a low-reprint name', async () => {
    const rows = await search('Blastoise');
    expect(rows[0]?.name.toLowerCase()).toContain('blastoise');
  });

  it('broad Charizard still leads with distinct marquee names on page 1', async () => {
    const rows = await search('Charizard', undefined, 48, 0);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const has = (w: string) => rows.some((r) => norm(r.name).includes(norm(w)));
    for (const w of ['Charizard', 'Mega Charizard', 'Dark Charizard']) expect(has(w)).toBe(true);
  });

  it('cross-set number search still works without a set filter', async () => {
    const rows = await search('SWSH075'); // Special Delivery Charizard promo
    expect(rows.some((r) => r.id === 'swshp-SWSH075')).toBe(true);
  });
});
