/**
 * Reconcile the master collector universe (universe.jsonl, built from TCGplayer/
 * TCGCSV) against the live SetValue catalog, at the level of the PHYSICAL
 * COLLECTIBLE IDENTITY: base card + set + number + treatment.
 *
 * Every universe product is classified through exact, tiered matching (never a
 * borrowed price, never a fuzzy merge):
 *   PRESENT_PRICED     — catalogued, the exact identity carries its own price
 *   PRESENT_UNVALUED   — catalogued, no independent price yet (kept, not omitted)
 *   MISSING_TREATMENT  — the base card exists but this recognized treatment does not
 *   MISSING_CARD       — no card at this name+number: a collector can substantiate
 *                        it externally but cannot catalog it in SetValue  ← real gap
 *
 * Output: reconcile.report.json (machine-readable, every row) + a value-banded
 * summary. Rerun any time to get the CURRENT remaining-gap number.
 *   node scripts/audit/reconcile.mjs [dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { query } from '../deploy/https-sql.mjs';

const DIR = process.argv[2] || '/tmp/claude-0/-home-user-PokemonAppW/1dbe54d1-2ee7-5c79-ba60-84548738d4d5/scratchpad/universe';
const uni = readFileSync(`${DIR}/universe.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`universe products: ${uni.length}`);

const strip = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
const nname = (s) => strip(s).toLowerCase()
  .replace(/★|\bgold star\b/g, ' gold star ').replace(/δ|\bdelta\b/g, ' delta ')
  .replace(/♀/g, ' female ').replace(/♂/g, ' male ')
  .replace(/\blv\.?\s*x\b/g, ' lvx ').replace(/[’']/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/^m\s+/, 'mega ').replace(/\s+/g, ' ').trim();
const cnum = (n) => { if (n == null) return ''; let s = String(n).toUpperCase().split('/')[0].replace(/\s+/g, ''); const m = s.match(/^([A-Z-]*?)0*([0-9]+)([A-Z]*)$/); return m ? m[1] + String(+m[2]) + m[3] : s; };
const digits = (n) => { const m = String(n ?? '').match(/[0-9]+/); return m ? String(+m[0]) : ''; };

// ---- prod dump ----
console.log('dumping prod…');
const cards = await query(`select id, set_id, number, name from public.cards`);
const variants = await query(`select card_id, variant, treatment from public.card_variants`);
const pricedRows = await query(`select v.card_id, v.variant, bool_or(p.market_cents is not null) priced
  from public.card_variants v left join public.prices p on p.card_id=v.card_id and p.variant=v.variant and p.provider='tcgplayer'
  group by v.card_id, v.variant`);
const ppids = new Set((await query(`select distinct provider_product_id from public.prices where provider_product_id is not null`)).map((r) => String(r.provider_product_id)));

const cardByNameNum = new Map();   // nname|cnum -> [card]
const cardByNameDig = new Map();   // nname|digits -> [card]
for (const c of cards) {
  const k1 = nname(c.name) + '|' + cnum(c.number);
  const k2 = nname(c.name) + '|' + digits(c.number);
  (cardByNameNum.get(k1) || cardByNameNum.set(k1, []).get(k1)).push(c);
  (cardByNameDig.get(k2) || cardByNameDig.set(k2, []).get(k2)).push(c);
}
const treatmentsByCard = new Map(); // card_id -> Set(treatment)
for (const v of variants) (treatmentsByCard.get(v.card_id) || treatmentsByCard.set(v.card_id, new Set()).get(v.card_id)).add(v.treatment || 'base');
const pricedByCV = new Map();
for (const r of pricedRows) pricedByCV.set(r.card_id + '|' + r.variant, r.priced);
const anyPricedByCardTreatment = new Map(); // card_id|treatment -> priced?
for (const v of variants) {
  const key = v.card_id + '|' + (v.treatment || 'base');
  const priced = pricedByCV.get(v.card_id + '|' + v.variant) || false;
  anyPricedByCardTreatment.set(key, (anyPricedByCardTreatment.get(key) || false) || priced);
}

// ---- reconcile ----
const out = [];
for (const u of uni) {
  const treat = u.treatment || 'base';
  let cls, cardId = null, note = '';
  if (ppids.has(String(u.productId))) {
    cls = 'PRESENT'; note = 'ppid'; // exact product already tracked
  } else {
    const k1 = nname(u.base) + '|' + cnum(u.number);
    const k2 = nname(u.base) + '|' + digits(u.number);
    const hit = (cardByNameNum.get(k1) || cardByNameDig.get(k2) || [])[0];
    if (!hit) { cls = 'MISSING_CARD'; }
    else {
      cardId = hit.id;
      const treats = treatmentsByCard.get(hit.id) || new Set(['base']);
      if (treats.has(treat)) {
        const priced = anyPricedByCardTreatment.get(hit.id + '|' + treat);
        cls = priced ? 'PRESENT_PRICED' : 'PRESENT_UNVALUED';
      } else {
        cls = 'MISSING_TREATMENT';
      }
    }
  }
  out.push({ productId: u.productId, group: u.groupName, number: u.number, name: u.base, fullName: u.name,
    treatment: treat, marketCents: u.marketCents, cardId, cls, note });
}

// ---- summarize ----
const band = (c) => c == null ? 'unpriced' : c >= 100000 ? '$1000+' : c >= 50000 ? '$500+' : c >= 25000 ? '$250+' : c >= 10000 ? '$100+' : '<$100';
const clsCount = {}, bandGap = {};
for (const r of out) {
  clsCount[r.cls] = (clsCount[r.cls] || 0) + 1;
  const missing = r.cls === 'MISSING_CARD' || r.cls === 'MISSING_TREATMENT';
  if (missing) { const b = band(r.marketCents); (bandGap[b] ||= { count: 0 }).count++; }
}
writeFileSync(`${DIR}/reconcile.report.json`, JSON.stringify(out));
const missing = out.filter((r) => r.cls === 'MISSING_CARD' || r.cls === 'MISSING_TREATMENT');
writeFileSync(`${DIR}/missing.json`, JSON.stringify(missing, null, 1));
console.log('\n== classification ==');
for (const [k, v] of Object.entries(clsCount).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
console.log('\n== missing identities by market band ==');
for (const b of ['$1000+', '$500+', '$250+', '$100+', '<$100', 'unpriced']) console.log(`  ${b.padEnd(9)} ${bandGap[b]?.count || 0}`);
console.log(`\ntotal missing: ${missing.length}  (MISSING_CARD ${clsCount.MISSING_CARD || 0}, MISSING_TREATMENT ${clsCount.MISSING_TREATMENT || 0})`);
console.log('\ntop missing by value:');
for (const r of missing.filter((r) => r.marketCents != null).sort((a, b) => b.marketCents - a.marketCents).slice(0, 25))
  console.log(`  $${(r.marketCents / 100).toFixed(2).padStart(9)} | ${r.cls.padEnd(17)} | ${r.fullName} | #${r.number} | ${r.group}`);
