/**
 * Reconcile the master collector universe (universe.jsonl, built from TCGplayer/
 * TCGCSV) against the live SetValue catalog at the level of the PHYSICAL
 * COLLECTIBLE IDENTITY: base card + set + collector number + treatment.
 *
 * Existence is decided by SET + NUMBER, never by name. TCGplayer and pokemontcg
 * name the same card very differently ("Charizard Star (Delta Species)" vs
 * "Charizard ★ δ"), so a group→set map is bootstrapped from the products that DO
 * match by product-id or name+number, then every remaining product is checked
 * against prod purely by (resolved set, canonical number) + treatment. No price
 * is ever borrowed; no economically distinct identity is merged.
 *
 * Classes: PRESENT_PRICED / PRESENT_UNVALUED / MISSING_TREATMENT / MISSING_CARD /
 *          OOS_SEALED / OOS_JAPANESE / SET_UNMAPPED.
 * Output: reconcile.report.json + missing.json + value-banded summary. Rerunnable.
 *   node scripts/audit/reconcile.mjs [dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { query } from '../deploy/https-sql.mjs';

const DIR = process.argv[2] || '/tmp/claude-0/-home-user-PokemonAppW/1dbe54d1-2ee7-5c79-ba60-84548738d4d5/scratchpad/universe';
const uni = readFileSync(`${DIR}/universe.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const strip = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
const nname = (s) => strip(s).toLowerCase()
  .replace(/★|\bgold\s*star\b|\bstar\b/g, ' goldstar ').replace(/δ|\bdelta\s*species\b|\bdelta\b/g, ' delta ')
  .replace(/♀/g, ' f ').replace(/♂/g, ' m ').replace(/\blv\.?\s*x\b/g, ' lvx ').replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/^m\s+/, 'mega ').replace(/\s+/g, ' ').trim();
const cnum = (n) => { if (n == null) return ''; let s = String(n).toUpperCase().split('/')[0].replace(/\s+/g, ''); const m = s.match(/^([A-Z-]*?)0*([0-9]+)([A-Z]*)$/); return m ? m[1] + String(+m[2]) + m[3] : s; };
const isJapanesePromo = (n) => /\/[A-Z]{1,4}-P$/i.test(String(n || ''));
const isForeign = (name) => /\((?:spanish|french|german|italian|portuguese|korean|chinese|japanese)\b|japanese exclusive|korean exclusive/i.test(name || '');
const isSealed = (name, num) => !num || /booster|\bbox\b|bundle|\bpack\b|\bcase\b|\btin\b|collection|elite trainer|display|blister|premium|portfolio|sleeve|build\s*&?\s*battle|mini tin|poster|binder|playmat|\bpin\b|figure|plush|charm|\bcoin\b|gift set|calendar|advent|treat|stocking|\bdeck\b/i.test(name || '');

console.log(`universe products: ${uni.length}\ndumping prod…`);
const cards = await query(`select id, set_id, number, name from public.cards`);
const variants = await query(`select card_id, variant, treatment from public.card_variants`);
const pricedRows = await query(`select v.card_id, v.variant, bool_or(p.market_cents is not null) priced
  from public.card_variants v left join public.prices p on p.card_id=v.card_id and p.variant=v.variant and p.provider='tcgplayer'
  group by v.card_id, v.variant`);
// productId -> the exact prod (card, variant) it was ingested as, plus whether priced.
// A ppid match means SetValue already tracks that exact physical product, whatever
// treatment token it was filed under — so it is PRESENT, no treatment guessing.
const ppids = new Map((await query(`select p.provider_product_id, p.card_id, p.variant, (p.market_cents is not null) priced
  from public.prices p where p.provider_product_id is not null`)).map((r) => [String(r.provider_product_id), r]));

const cardById = new Map(cards.map((c) => [c.id, c]));
const numBySet = new Map();       // set_id -> Map(cnum -> card)
const cardByNameNum = new Map();  // nname|cnum -> card (bootstrap only)
for (const c of cards) {
  (numBySet.get(c.set_id) || numBySet.set(c.set_id, new Map()).get(c.set_id)).set(cnum(c.number), c);
  const k = nname(c.name) + '|' + cnum(c.number);
  if (!cardByNameNum.has(k)) cardByNameNum.set(k, c);
}
const treatsByCard = new Map();
for (const v of variants) (treatsByCard.get(v.card_id) || treatsByCard.set(v.card_id, new Set()).get(v.card_id)).add(v.treatment || 'base');
const pricedCT = new Map(); // card|treatment -> priced
{ const pcv = new Map(pricedRows.map((r) => [r.card_id + '|' + r.variant, r.priced]));
  for (const v of variants) { const k = v.card_id + '|' + (v.treatment || 'base'); pricedCT.set(k, (pricedCT.get(k) || false) || (pcv.get(v.card_id + '|' + v.variant) || false)); } }

// ---- pass 1: bootstrap group -> set via ppid + name+number matches ----
const votes = new Map(); // group -> Map(set_id -> count)
for (const u of uni) {
  if (isSealed(u.name, u.number) || isJapanesePromo(u.number) || isForeign(u.name)) continue;
  let card = null;
  if (ppids.has(String(u.productId))) card = cardById.get(ppids.get(String(u.productId)).card_id);
  if (!card) card = cardByNameNum.get(nname(u.base) + '|' + cnum(u.number));
  if (card) { const m = votes.get(u.groupName) || votes.set(u.groupName, new Map()).get(u.groupName); m.set(card.set_id, (m.get(card.set_id) || 0) + 1); }
}
const groupSet = new Map();
for (const [g, m] of votes) { let best = null, n = -1; for (const [s, c] of m) if (c > n) { n = c; best = s; } groupSet.set(g, best); }

// ---- pass 2: classify every product by set+number ----
const out = [];
for (const u of uni) {
  const base = { productId: u.productId, group: u.groupName, number: u.number, name: u.base, fullName: u.name, treatment: u.treatment || 'base', marketCents: u.marketCents };
  if (isSealed(u.name, u.number)) { out.push({ ...base, cls: 'OOS_SEALED', cardId: null }); continue; }
  if (isJapanesePromo(u.number)) { out.push({ ...base, cls: 'OOS_JAPANESE', cardId: null }); continue; }
  if (isForeign(u.name)) { out.push({ ...base, cls: 'OOS_LANGUAGE', cardId: null }); continue; }
  // ppid = the exact product is already tracked as a specific prod variant → PRESENT.
  const pp = ppids.get(String(u.productId));
  if (pp) { out.push({ ...base, cls: pp.priced ? 'PRESENT_PRICED' : 'PRESENT_UNVALUED', cardId: pp.card_id, resolvedSet: cardById.get(pp.card_id)?.set_id || null, note: 'ppid:' + pp.variant }); continue; }
  let card = null;
  const set = groupSet.get(u.groupName);
  if (!card && set) card = numBySet.get(set)?.get(cnum(u.number));
  if (!card) card = cardByNameNum.get(nname(u.base) + '|' + cnum(u.number)); // last resort
  if (!card) { out.push({ ...base, cls: set ? 'MISSING_CARD' : 'SET_UNMAPPED', cardId: null, resolvedSet: set || null }); continue; }
  const treat = u.treatment || 'base';
  const treats = treatsByCard.get(card.id) || new Set(['base']);
  if (!treats.has(treat)) { out.push({ ...base, cls: 'MISSING_TREATMENT', cardId: card.id, resolvedSet: card.set_id }); continue; }
  const priced = pricedCT.get(card.id + '|' + treat);
  out.push({ ...base, cls: priced ? 'PRESENT_PRICED' : 'PRESENT_UNVALUED', cardId: card.id, resolvedSet: card.set_id });
}

// ---- summarize ----
const band = (c) => c == null ? 'unpriced' : c >= 100000 ? '$1000+' : c >= 50000 ? '$500+' : c >= 25000 ? '$250+' : c >= 10000 ? '$100+' : '<$100';
const clsCount = {}, bandGap = {};
for (const r of out) { clsCount[r.cls] = (clsCount[r.cls] || 0) + 1; if (r.cls === 'MISSING_CARD' || r.cls === 'MISSING_TREATMENT') bandGap[band(r.marketCents)] = (bandGap[band(r.marketCents)] || 0) + 1; }
writeFileSync(`${DIR}/reconcile.report.json`, JSON.stringify(out));
const missing = out.filter((r) => r.cls === 'MISSING_CARD' || r.cls === 'MISSING_TREATMENT' || r.cls === 'SET_UNMAPPED');
writeFileSync(`${DIR}/missing.json`, JSON.stringify(missing, null, 1));
console.log('\n== classification ==');
for (const [k, v] of Object.entries(clsCount).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
console.log('\n== in-scope missing by market band ==');
for (const b of ['$1000+', '$500+', '$250+', '$100+', '<$100', 'unpriced']) console.log(`  ${b.padEnd(9)} ${bandGap[b] || 0}`);
console.log(`\ntotal in-scope missing: ${(clsCount.MISSING_CARD || 0) + (clsCount.MISSING_TREATMENT || 0)}  (card ${clsCount.MISSING_CARD || 0}, treatment ${clsCount.MISSING_TREATMENT || 0}, set_unmapped ${clsCount.SET_UNMAPPED || 0})`);
console.log('\ntop in-scope missing by value:');
for (const r of missing.filter((r) => r.marketCents != null && r.cls !== 'SET_UNMAPPED').sort((a, b) => b.marketCents - a.marketCents).slice(0, 30))
  console.log(`  $${(r.marketCents / 100).toFixed(2).padStart(9)} | ${r.cls.padEnd(17)} | ${r.fullName.slice(0, 46).padEnd(46)} | #${r.number} | set=${r.resolvedSet || '?'} | ${r.group}`);
