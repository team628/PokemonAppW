import { withIdentity } from '../db/pg';
import { isVariant, primaryVariant, type Variant } from '../catalog/variants';
import { CONDITIONS, type Condition } from '../domain/conditions';

/**
 * Collection import.
 *
 * A collector arriving with a spreadsheet of 4,000 cards is the single biggest
 * moment of trust in this product. Getting a row wrong is worse than refusing
 * it: a silently mismatched card corrupts a completion percentage that the
 * collector will then rely on for years.
 *
 * So the matcher is deliberately conservative. It resolves a row only when the
 * evidence is unambiguous, and everything else is reported back with the reason
 * rather than being quietly guessed at or dropped.
 */

export type MatchConfidence = 'exact' | 'ambiguous' | 'unmatched';

export interface ParsedRow {
  line: number;
  raw: Record<string, string>;
  setHint: string | null;
  numberHint: string | null;
  nameHint: string | null;
  quantity: number;
  condition: Condition;
  variant: Variant | null;
  paidCents: number | null;
}

export interface MatchedRow extends ParsedRow {
  confidence: MatchConfidence;
  cardId?: string;
  cardName?: string;
  setName?: string;
  resolvedVariant?: Variant;
  /** Why this row could not be resolved, or which alternatives collided. */
  reason?: string;
  candidates?: { cardId: string; label: string }[];
}

export interface ImportPreview {
  rows: MatchedRow[];
  matched: number;
  ambiguous: number;
  unmatched: number;
  totalQuantity: number;
}

// ------------------------------------------------------------------ parsing --

/** RFC4180-ish CSV reader: handles quoted fields, embedded commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Header aliases covering the exports collectors actually arrive with. */
const HEADERS: Record<string, string[]> = {
  set: ['set', 'set name', 'setname', 'edition', 'expansion', 'series', 'set code', 'setid', 'set id'],
  number: ['number', 'card number', 'cardnumber', 'no', 'no.', 'collector number', '#', 'card #'],
  name: ['name', 'card name', 'cardname', 'product name', 'card', 'title'],
  quantity: ['quantity', 'qty', 'count', 'amount', 'have'],
  condition: ['condition', 'card condition', 'grade'],
  variant: ['variant', 'printing', 'finish', 'foil', 'rarity type', 'subtype name', 'sub type name'],
  price: ['price', 'paid', 'purchase price', 'cost', 'price paid', 'my price', 'purchase'],
};

function headerIndex(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADERS)) {
      if (map[field] === undefined && aliases.includes(key)) map[field] = i;
    }
  });
  return map;
}

const CONDITION_ALIASES: Record<string, Condition> = {
  'near mint': 'NM', nm: 'NM', mint: 'NM', m: 'NM', 'near mint holofoil': 'NM',
  'lightly played': 'LP', lp: 'LP', 'slightly played': 'LP', sp: 'LP', ex: 'LP', excellent: 'LP',
  'moderately played': 'MP', mp: 'MP', played: 'MP', good: 'MP', gd: 'MP',
  'heavily played': 'HP', hp: 'HP', poor: 'HP',
  damaged: 'DMG', dmg: 'DMG', d: 'DMG',
};

const VARIANT_ALIASES: Record<string, Variant> = {
  normal: 'normal', regular: 'normal', nonfoil: 'normal', 'non-foil': 'normal', unlimited: 'unlimited',
  holo: 'holofoil', holofoil: 'holofoil', foil: 'holofoil', 'holo rare': 'holofoil',
  reverse: 'reverseHolofoil', 'reverse holo': 'reverseHolofoil', 'reverse holofoil': 'reverseHolofoil',
  rh: 'reverseHolofoil', 'reverse foil': 'reverseHolofoil',
  '1st edition': '1stEditionNormal', '1st edition normal': '1stEditionNormal',
  '1st edition holofoil': '1stEditionHolofoil', '1st edition holo': '1stEditionHolofoil',
  'unlimited holofoil': 'unlimitedHolofoil',
};

/** Unknown condition wording falls back to Near Mint rather than guessing a discount. */
function toCondition(raw: string): Condition {
  const key = raw.trim().toLowerCase();
  if (!key) return 'NM';
  const alias = CONDITION_ALIASES[key];
  if (alias) return alias;
  const upper = key.toUpperCase();
  return (CONDITIONS as readonly string[]).includes(upper) ? (upper as Condition) : 'NM';
}

export function parseRows(text: string): { rows: ParsedRow[]; header: string[]; recognised: string[] } {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], header: [], recognised: [] };

  const header = table[0]!.map((h) => h.trim());
  const idx = headerIndex(header);
  const rows: ParsedRow[] = [];

  for (let i = 1; i < table.length; i++) {
    const cells = table[i]!;
    const at = (field: string) => {
      const j = idx[field];
      return j === undefined ? '' : (cells[j] ?? '').trim();
    };

    const raw: Record<string, string> = {};
    header.forEach((h, j) => { raw[h] = (cells[j] ?? '').trim(); });

    const qty = parseInt(at('quantity') || '1', 10);
    const conditionRaw = at('condition').toLowerCase();
    const variantRaw = at('variant').toLowerCase();
    const priceRaw = at('price').replace(/[^0-9.]/g, '');

    // "4/102" and "SV049/SV122" both mean the left-hand side.
    const numberRaw = at('number').split('/')[0]?.trim().replace(/^#/, '') ?? '';

    rows.push({
      line: i + 1,
      raw,
      setHint: at('set') || null,
      numberHint: numberRaw || null,
      nameHint: at('name') || null,
      quantity: Number.isFinite(qty) && qty > 0 ? Math.min(qty, 999) : 1,
      condition: toCondition(conditionRaw),
      variant: VARIANT_ALIASES[variantRaw] ?? (isVariant(variantRaw) ? variantRaw : null),
      paidCents: priceRaw ? Math.round(parseFloat(priceRaw) * 100) : null,
    });
  }

  return { rows, header, recognised: Object.keys(idx) };
}

// ----------------------------------------------------------------- matching --

const normalise = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

interface CardLookupRow {
  id: string;
  name: string;
  number: string;
  set_id: string;
  set_name: string;
  ptcgo_code: string | null;
}

/**
 * Resolves parsed rows against the catalog.
 *
 * Set + number is the only identifier that is genuinely unique, so it is tried
 * first. A name-only match is accepted solely when exactly one card in the
 * entire catalog bears that name; otherwise the row comes back as ambiguous
 * with its candidates, for a human to settle.
 */
export async function matchRows(userId: string, rows: ParsedRow[]): Promise<ImportPreview> {
  return withIdentity(userId, async (tx) => {
  const sets = await tx.rows<{ id: string; name: string; ptcgo_code: string | null }>(
    'select id, name, ptcgo_code from public.sets');

  const setByKey = new Map<string, string>();
  for (const s of sets) {
    setByKey.set(normalise(s.id), s.id);
    setByKey.set(normalise(s.name), s.id);
    if (s.ptcgo_code) setByKey.set(normalise(s.ptcgo_code), s.id);
  }

  const CARD_SELECT =
    'select c.id, c.name, c.number, c.set_id, s.name as set_name, s.ptcgo_code from public.cards c join public.sets s on s.id = c.set_id';
  const findByNumber = (setId: string, num: string) =>
    tx.rows<CardLookupRow>(`${CARD_SELECT} where c.set_id = $1 and c.number = $2`, [setId, num]);
  const findByName = (name: string) =>
    tx.rows<CardLookupRow>(`${CARD_SELECT} where lower(c.name) = lower($1) limit 6`, [name]);
  const findByNameInSet = (setId: string, name: string) =>
    tx.rows<CardLookupRow>(`${CARD_SELECT} where c.set_id = $1 and lower(c.name) = lower($2) limit 6`, [setId, name]);
  const variantsFor = (cardId: string) =>
    tx.rows<{ variant: string; is_primary: boolean }>(
      'select variant, is_primary from public.card_variants where card_id = $1', [cardId]);

  const out: MatchedRow[] = [];
  let matched = 0, ambiguous = 0, unmatched = 0, totalQuantity = 0;

  for (const row of rows) {
    const setId = row.setHint ? setByKey.get(normalise(row.setHint)) : undefined;
    let hits: CardLookupRow[] = [];
    let reason: string | undefined;

    if (setId && row.numberHint) {
      hits = await findByNumber(setId, row.numberHint);
      if (!hits.length && row.nameHint) {
        hits = await findByNameInSet(setId, row.nameHint);
        if (!hits.length) reason = `No card numbered ${row.numberHint} or named "${row.nameHint}" in that set.`;
      } else if (!hits.length) {
        reason = `No card numbered ${row.numberHint} in that set.`;
      }
    } else if (setId && row.nameHint) {
      hits = await findByNameInSet(setId, row.nameHint);
      if (!hits.length) reason = `No card named "${row.nameHint}" in that set.`;
    } else if (row.nameHint) {
      hits = await findByName(row.nameHint);
      if (!hits.length) reason = `No card named "${row.nameHint}".`;
      else if (hits.length > 1) reason = 'That card name appears in several sets — a set column would resolve it.';
    } else {
      reason = row.setHint
        ? 'Row has a set but no card number or name.'
        : 'Row has no set, number or card name to match on.';
    }

    if (hits.length === 1) {
      const hit = hits[0]!;
      const available = await variantsFor(hit.id);
      const names = available.map((v) => v.variant as Variant);
      // An explicitly stated printing is honoured only if the card has it.
      const resolved =
        row.variant && names.includes(row.variant)
          ? row.variant
          : (available.find((v) => v.is_primary)?.variant as Variant | undefined) ??
            primaryVariant(names);

      out.push({
        ...row,
        confidence: 'exact',
        cardId: hit.id,
        cardName: hit.name,
        setName: hit.set_name,
        resolvedVariant: resolved,
        reason:
          row.variant && !names.includes(row.variant)
            ? `This card has no ${row.variant} printing — imported as ${resolved}.`
            : undefined,
      });
      matched++;
      totalQuantity += row.quantity;
    } else if (hits.length > 1) {
      out.push({
        ...row,
        confidence: 'ambiguous',
        reason,
        candidates: hits.map((h) => ({ cardId: h.id, label: `${h.name} #${h.number} · ${h.set_name}` })),
      });
      ambiguous++;
    } else {
      out.push({ ...row, confidence: 'unmatched', reason });
      unmatched++;
    }
  }

  return { rows: out, matched, ambiguous, unmatched, totalQuantity };
  });
}
