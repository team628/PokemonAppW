// Terminal classifier for reconcile-flagged "missing" identities.
//
// Reads data/audit/remaining-gap.json (the reconcile harness's residual list) and,
// for each item, verifies against the live catalog which terminal bucket it falls
// in: physically present via an aggregation-set base card, present via a main-set
// base card (stamp not separately modelled), a parser false-positive, an
// unresolvable number-collision, a league-family duplication-risk hold, or a truly
// unrepresented identity. Prints an honest true-missing count and enumerates the
// genuinely-unrepresented items with reasons. Rerunnable: `node scripts/audit/classify-remaining.mjs`.
import { query } from '../deploy/https-sql.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const D = ROOT + '/data/audit';
const missing = JSON.parse(readFileSync(D + '/remaining-gap.json'));
const nname = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/★/g,' goldstar ').replace(/δ/g,' delta ').replace(/[’']/g,'').replace(/[^a-z0-9]+/g, ' ').trim();
const cnum = (n) => { if (n == null) return ''; let s = String(n).toUpperCase().split('/')[0].replace(/\s+/g, ''); const m = s.match(/^([A-Z-]*?)0*([0-9]+)([A-Z]*)$/); return m ? m[1]+String(+m[2])+m[3] : s; };
const pokemonOf = (full) => (full || '').split(' - ')[0].replace(/\s*\([^)]*\)\s*/g,' ').replace(/\s*\[[^\]]*\]\s*/g,' ').trim();
const totalOf = (full,num) => { const m = String(num||'').match(/\/(\d+)/)||String(full||'').match(/\/(\d+)/); return m?+m[1]:null; };
const AGG = new Set(['league-and-championship-cards','miscellaneous-cards-and-products','prize-pack-series-cards','blister-exclusives','deck-exclusives','world-championship-decks','jumbo-cards','battle-academy','battle-academy-2022','battle-academy-2024']);
const LEAGUE_FAM = new Set(['league','winner','finalist','participation','first_place','second_place','third_place','fourth_place']);
const setTotals = Object.fromEntries((await query(`select id,printed_total,total from public.sets`)).map((s)=>[s.id,{p:s.printed_total,t:s.total}]));

const buckets = {};
const push = (b, item) => { (buckets[b] = buckets[b]||[]).push(item); };
for (const r of missing) {
  const poke = pokemonOf(r.fullName), wn = nname(poke), cn = cnum(r.number), tot = totalOf(r.fullName, r.number);
  const first = wn.split(' ')[0] || '';
  const rows = first ? await query(`select c.id,c.set_id,c.name,c.number,
      (select array_agg(v.variant) from public.card_variants v where v.card_id=c.id) vars
    from public.cards c where c.number is not null and search_normalize(c.name) like '%${first.replace(/'/g,"''")}%'`) : [];
  const agg = rows.filter((c)=>AGG.has(c.set_id) && cnum(c.number)===cn && nname(c.name)===wn);
  const main = rows.filter((c)=>!AGG.has(c.set_id) && cnum(c.number)===cn && nname(c.name)===wn);
  const item = { fullName:r.fullName, number:r.number, set:r.resolvedSet, treat:r.treatment, $:(r.marketCents||0)/100 };
  if (/pokemon center (lady|lass)/i.test(poke)) { push('PARSER_FALSE_POSITIVE_present_as_base', {...item, at: rows.filter(c=>cnum(c.number)===cn&&nname(c.name)===wn).map(c=>c.id)[0]}); continue; }
  if (agg.length) { push('PRESENT_VIA_AGG_BASE_card', {...item, at: agg.map(c=>c.id)[0]}); continue; }
  if (main.length) {
    const famOnMain = main.some((c)=>(c.vars||[]).some((v)=>LEAGUE_FAM.has(String(v).split('__')[1])));
    if (LEAGUE_FAM.has(r.treat) && famOnMain) { push('LEAGUE_FAMILY_DUP_RISK_hold', {...item, at: main.map(c=>c.id)[0]}); continue; }
    push('MAIN_SET_BASE_PRESENT_treatment_not_added', {...item, at: main.map(c=>c.id)[0]}); continue;
  }
  // no confident base anywhere
  const anyName = rows.filter((c)=>nname(c.name)===wn);
  const numColl = rows.filter((c)=>cnum(c.number)===cn);
  if (numColl.length && !anyName.length) { push('UNRESOLVABLE_NUMBER_COLLISION_hold', {...item, cands: numColl.slice(0,3).map(c=>c.id+':'+c.name)}); continue; }
  push('TRULY_UNREPRESENTED_no_base_anywhere', item);
}
writeFileSync(D + '/reconcile-terminal-buckets.json', JSON.stringify(buckets, null, 1));
let total=0; const order = Object.keys(buckets).sort((a,b)=>buckets[b].length-buckets[a].length);
console.log('=== TERMINAL CLASSIFICATION of remaining reconcile-missing ===');
for (const b of order) { const n=buckets[b].length; total+=n; const val=buckets[b].reduce((s,x)=>s+x.$,0); console.log(`  ${n.toString().padStart(3)}  ${b}   (\$${val.toFixed(2)} agg)`); }
console.log(`  ${total.toString().padStart(3)}  TOTAL`);
const trueGap = (buckets['TRULY_UNREPRESENTED_no_base_anywhere']||[]);
console.log(`\n--- TRULY UNREPRESENTED (no physical representation anywhere): ${trueGap.length} ---`);
for (const x of trueGap.sort((a,b)=>b.$-a.$)) console.log(`  \$${x.$.toFixed(2).padStart(8)} | ${x.fullName}  [set=${x.set}]`);
const dup = buckets['LEAGUE_FAMILY_DUP_RISK_hold']||[]; console.log(`\n--- LEAGUE-FAMILY DUP-RISK HOLD: ${dup.length} ---`);
for (const x of dup.sort((a,b)=>b.$-a.$)) console.log(`  \$${x.$.toFixed(2).padStart(8)} | ${x.fullName} -> ${x.at}`);
const coll = buckets['UNRESOLVABLE_NUMBER_COLLISION_hold']||[]; console.log(`\n--- UNRESOLVABLE COLLISION HOLD: ${coll.length} ---`);
for (const x of coll.sort((a,b)=>b.$-a.$).slice(0,12)) console.log(`  \$${x.$.toFixed(2).padStart(8)} | ${x.fullName} -> ${(x.cands||[]).join(', ')}`);
