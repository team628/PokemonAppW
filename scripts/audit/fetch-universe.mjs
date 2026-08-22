/**
 * Build the master collector universe from the authoritative commercial catalog
 * (TCGplayer, via TCGCSV — the same source SetValue's catalog is derived from).
 *
 * Fetches every English Pokémon group's products + prices and writes a compact,
 * normalized identity stream to universe.jsonl: one line per TCGplayer product,
 * parsed into (group, number, base name, treatment, market price, productId).
 * This is the OUTSIDE-SetValue truth the reconciler measures the catalog against.
 *
 * Rerunnable: re-run any time to pick up newly released products.
 *   node scripts/audit/fetch-universe.mjs [outDir]
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] || '/tmp/claude-0/-home-user-PokemonAppW/1dbe54d1-2ee7-5c79-ba60-84548738d4d5/scratchpad/universe';
mkdirSync(OUT, { recursive: true });
const CAT = 3; // Pokemon
const curl = (url) => JSON.parse(execFileSync('curl', ['-s', '--max-time', '60', url], { maxBuffer: 1 << 30 }).toString() || '{}');

// Treatment token parsed from a TCGplayer product name suffix. Mirrors migration
// 0021's controlled vocabulary. Base if no recognized suffix.
function treatmentOf(name) {
  const n = name.toLowerCase();
  const has = (re) => re.test(n);
  if (has(/prerelease.*staff|staff.*prerelease/)) return 'prerelease_staff';
  if (has(/\[staff\]|\(staff\)|staff\b/)) return 'staff';
  if (has(/prerelease/)) return 'prerelease';
  if (has(/cosmos holo/)) return 'cosmos_holo';
  if (has(/cracked ice/)) return 'cracked_ice';
  if (has(/galaxy holo/)) return 'galaxy_holo';
  if (has(/pok[eé]mon center/)) return 'pokemon_center';
  if (has(/prize pack/)) return 'prize_pack';
  if (has(/\bleague\b/)) return 'league';
  if (has(/national championship/)) return 'national_championship';
  if (has(/regional championship/)) return 'regional_championship';
  if (has(/state championship|state\/province|provincial championship/)) return 'state_championship';
  if (has(/world championship|worlds\b/)) return 'worlds';
  if (has(/\bwinner\b/)) return 'winner';
  if (has(/\bjumbo\b|oversiz/)) return 'jumbo';
  return 'base';
}
function ext(p, key) { for (const e of p.extendedData || []) if (e.name === key) return e.value; return null; }
function baseName(name) {
  // strip the ' - NNN' number suffix and any trailing (…)/[…] qualifier for the base identity name
  return name.replace(/\s*-\s*[A-Za-z0-9/]+\s*$/, '').replace(/\s*[\(\[][^\)\]]*[\)\]]\s*$/, '').trim();
}

const groups = (curl(`https://tcgcsv.com/tcgplayer/${CAT}/groups`).results) || [];
console.log(`groups: ${groups.length}`);
const lines = [];
let gi = 0;
for (const g of groups) {
  gi++;
  let prods, prices;
  try {
    prods = (curl(`https://tcgcsv.com/tcgplayer/${CAT}/${g.groupId}/products`).results) || [];
    prices = (curl(`https://tcgcsv.com/tcgplayer/${CAT}/${g.groupId}/prices`).results) || [];
  } catch (e) { console.log(`  group ${g.groupId} ${g.name}: FETCH ERR ${e.message}`); continue; }
  const pby = {};
  for (const q of prices) (pby[q.productId] ||= []).push(q);
  for (const p of prods) {
    const qs = pby[p.productId] || [];
    // market: prefer Holofoil then Normal then any non-null
    let market = null, subtype = null;
    for (const q of qs) if (q.marketPrice != null && (market == null || q.subTypeName === 'Holofoil')) { market = q.marketPrice; subtype = q.subTypeName; }
    lines.push(JSON.stringify({
      productId: p.productId, groupId: g.groupId, groupName: g.name, groupAbbr: g.abbreviation,
      published: g.publishedOn, name: p.name, base: baseName(p.name), number: ext(p, 'Number'),
      rarity: ext(p, 'Rarity'), cardType: ext(p, 'Card Type'), treatment: treatmentOf(p.name),
      marketCents: market == null ? null : Math.round(market * 100), url: p.url, image: p.imageUrl,
    }));
  }
  if (gi % 25 === 0) console.log(`  ...${gi}/${groups.length} groups, ${lines.length} products`);
}
writeFileSync(`${OUT}/universe.jsonl`, lines.join('\n'));
writeFileSync(`${OUT}/groups.json`, JSON.stringify(groups));
console.log(`DONE: ${lines.length} product-identities across ${groups.length} groups -> ${OUT}/universe.jsonl`);
