/**
 * Variant taxonomy.
 *
 * SetValue uses the market's own vocabulary (the TCGplayer printing keys)
 * rather than inventing a parallel one, because every price we quote is keyed
 * by these strings. A collector who owns "the reverse holo Bulbasaur" and a
 * price feed that quotes `reverseHolofoil` must be talking about the same
 * object or the whole NEED number is fiction.
 *
 * Which printings exist for a card is knowledge, not a guess, whenever a price
 * provider lists it. Where no provider data exists we fall back to era + rarity
 * rules and mark the variant `inferred` so the UI can say so out loud.
 */

export const VARIANTS = [
  'normal',
  'holofoil',
  'reverseHolofoil',
  '1stEditionNormal',
  '1stEditionHolofoil',
  'unlimitedHolofoil',
  'unlimited',
  '1stEdition',
  // Shadowless printings — historically real for Base Set only. Kept as
  // non-primary identities: they carry their own independent price and count
  // in master-mode goals, but never displace the primary printing a
  // main/complete goal requires, so existing completion math is unchanged.
  'shadowless',
  'shadowlessHolofoil',
] as const;

export type Variant = (typeof VARIANTS)[number];

export type VariantSource = 'market_data' | 'inferred';

export const VARIANT_LABEL: Record<Variant, string> = {
  normal: 'Normal',
  holofoil: 'Holo',
  reverseHolofoil: 'Reverse Holo',
  '1stEditionNormal': '1st Edition',
  '1stEditionHolofoil': '1st Ed. Holo',
  unlimitedHolofoil: 'Unlimited Holo',
  unlimited: 'Unlimited',
  '1stEdition': '1st Edition',
  shadowless: 'Shadowless',
  shadowlessHolofoil: 'Shadowless Holo',
};

export const VARIANT_SHORT: Record<Variant, string> = {
  normal: 'NM',
  holofoil: 'HOLO',
  reverseHolofoil: 'RH',
  '1stEditionNormal': '1ED',
  '1stEditionHolofoil': '1ED-H',
  unlimitedHolofoil: 'UNL-H',
  unlimited: 'UNL',
  '1stEdition': '1ED',
  shadowless: 'SHDW',
  shadowlessHolofoil: 'SHDW-H',
};

export function isVariant(v: string): v is Variant {
  return (VARIANTS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Treatment axis (migration 0021).
//
// A stored variant token is `finish` OR `finish__treatment` (a future language
// suffix `finish__treatment__lang` is tolerated but unused while the catalog is
// English-only). The `finish` part is one of the base printing tokens above; the
// `treatment` part is a recognised printing from the controlled vocabulary that
// the database itself enforces (the card_variants.treatment CHECK constraint).
//
// Validation is deliberately NOT a second hardcoded allow-list of full tokens:
// the token is accepted by *shape* here and its existence is authoritative in the
// database (the add path verifies the (card, variant) row exists; the importer
// only ever resolves against a card's real printings). Labels degrade gracefully
// — an unknown-to-the-UI treatment is humanised, never blank — so the display
// layer cannot silently fall behind the identity model either.
// ---------------------------------------------------------------------------

/** Recognised-printing vocabulary, mirroring the 0021 CHECK constraint. */
export const TREATMENTS = [
  'base', 'prerelease', 'staff', 'prerelease_staff', 'winner', 'worlds',
  'national_championship', 'regional_championship', 'state_championship',
  'prize_pack', 'league', 'pokemon_center', 'cosmos_holo', 'cracked_ice',
  'galaxy_holo', 'jumbo', 'other_recognized',
  // 0024: competitive placement / recognition stamps. Each is an independently
  // printed and independently priced physical identity, kept separate (never
  // collapsed) so a "2nd Place" promo never borrows a "3rd Place" copy's value.
  'first_place', 'second_place', 'third_place', 'fourth_place',
  'finalist', 'participation',
] as const;
export type Treatment = (typeof TREATMENTS)[number];

/** Collector-facing treatment names. Missing entries humanise (never blank). */
const TREATMENT_LABEL: Record<string, string> = {
  prerelease: 'Prerelease',
  staff: 'Staff',
  prerelease_staff: 'Prerelease Staff',
  winner: 'Winner',
  worlds: 'Worlds',
  national_championship: 'National Championship',
  regional_championship: 'Regional Championship',
  state_championship: 'State Championship',
  prize_pack: 'Prize Pack',
  league: 'League',
  pokemon_center: 'Pokémon Center',
  jumbo: 'Jumbo',
  other_recognized: 'Special Print',
  first_place: '1st Place',
  second_place: '2nd Place',
  third_place: '3rd Place',
  fourth_place: '4th Place',
  finalist: 'Finalist',
  participation: 'Participation',
};

/** Short treatment codes for compact set-grid / show-mode badges. */
const TREATMENT_SHORT: Record<string, string> = {
  prerelease: 'PRE', staff: 'STF', prerelease_staff: 'PRE·STF', winner: 'WIN',
  worlds: 'WLD', national_championship: 'NATL', regional_championship: 'RGNL',
  state_championship: 'STATE', prize_pack: 'PP', league: 'LG', pokemon_center: 'PC',
  cosmos_holo: 'CSM', cracked_ice: 'CI', galaxy_holo: 'GLX', jumbo: 'JMB',
  other_recognized: 'SP',
  first_place: '1ST', second_place: '2ND', third_place: '3RD', fourth_place: '4TH',
  finalist: 'FIN', participation: 'PART',
};

/** Treatments whose printing IS the whole label (a holo pattern, not a stamp). */
const TREATMENT_FINISH_OVERRIDE: Record<string, string> = {
  cosmos_holo: 'Cosmos Holo',
  cracked_ice: 'Cracked Ice Holo',
  galaxy_holo: 'Galaxy Holo',
};

/** Full finish names used when composing a treatment label (not the short base label). */
const FINISH_FULL: Record<string, string> = {
  normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse Holofoil',
  '1stEditionNormal': '1st Edition', '1stEdition': '1st Edition',
  '1stEditionHolofoil': '1st Edition Holofoil', unlimited: 'Unlimited',
  unlimitedHolofoil: 'Unlimited Holofoil', shadowless: 'Shadowless',
  shadowlessHolofoil: 'Shadowless Holofoil',
};

function humanise(treatment: string): string {
  return treatment.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export interface ParsedToken { finish: string; treatment: string; language: string }

/** Split a stored variant token into its identity axes. Never throws. */
export function parseVariantToken(token: string): ParsedToken {
  const [finish, treatment, language] = String(token).split('__');
  return { finish: finish ?? 'normal', treatment: treatment ?? 'base', language: language ?? 'EN' };
}

/** Structural validity of a variant token — a known finish, optional treatment/lang. */
export function isVariantTokenShape(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 80) return false;
  const { finish, treatment, language } = parseVariantToken(token);
  if (!(VARIANTS as readonly string[]).includes(finish)) return false;
  if (!/^[a-z0-9_]+$/.test(treatment)) return false;
  if (language !== 'EN' && !/^[A-Z]{2}$/.test(language)) return false;
  return true;
}

/** Full collector-facing printing label for any stored token. Never blank. */
export function variantLabel(token: string): string {
  const { finish, treatment } = parseVariantToken(token);
  if (treatment === 'base') {
    return VARIANT_LABEL[finish as Variant] ?? FINISH_FULL[finish] ?? finish;
  }
  if (TREATMENT_FINISH_OVERRIDE[treatment]) return TREATMENT_FINISH_OVERRIDE[treatment]!;
  const finishLabel = FINISH_FULL[finish] ?? finish;
  const treatLabel = TREATMENT_LABEL[treatment] ?? humanise(treatment);
  return `${finishLabel} · ${treatLabel}`;
}

/** Compact badge label for any stored token. Never blank. */
export function variantShort(token: string): string {
  const { finish, treatment } = parseVariantToken(token);
  if (treatment === 'base') {
    return VARIANT_SHORT[finish as Variant] ?? finish.slice(0, 4).toUpperCase();
  }
  const fin = VARIANT_SHORT[finish as Variant] ?? finish.slice(0, 2).toUpperCase();
  const tr = TREATMENT_SHORT[treatment] ?? humanise(treatment).slice(0, 3).toUpperCase();
  return `${fin}·${tr}`;
}

/** A token carries a recognised premium treatment (not a plain base printing). */
export function isTreatmentVariant(token: string): boolean {
  return parseVariantToken(token).treatment !== 'base';
}

const FINISH_BY_LOWER = new Map((VARIANTS as readonly string[]).map((v) => [v.toLowerCase(), v]));

/**
 * Canonicalise a case-insensitive CSV variant cell to a stored token, or null.
 * Accepts `holofoil`, `Reverse Holofoil`→`reverseHolofoil` is NOT handled here
 * (that is the human-alias job in the importer); this handles the canonical
 * machine forms `finish` and `finish__treatment` regardless of case, so a CSV
 * this app exported (`reverseHolofoil__winner`) round-trips even after the
 * importer lower-cases surrounding text.
 */
export function canonicaliseVariantToken(raw: string): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const parts = s.split('__');
  const finish = FINISH_BY_LOWER.get((parts[0] ?? '').toLowerCase());
  if (!finish) return null;
  if (parts.length === 1) return finish;
  const treatment = (parts[1] ?? '').toLowerCase();
  const token = parts.length >= 3 ? `${finish}__${treatment}__${parts[2]!.toUpperCase()}` : `${finish}__${treatment}`;
  return isVariantTokenShape(token) ? token : null;
}

/**
 * Rarities that are printed holofoil by definition. Anything matching here has
 * no plain "normal" printing, and (crucially) no reverse holo — you cannot pull
 * a reverse holo of a card that only exists as a holo.
 */
const HOLO_ONLY = [
  /^Rare Holo/i,
  /^Rare Ultra/i,
  /^Rare Secret/i,
  /^Rare Rainbow/i,
  /^Rare Shiny/i,
  /^Rare Prime/i,
  /^Rare BREAK/i,
  /^Rare ACE/i,
  /^Rare Prism/i,
  /^Amazing Rare/i,
  /^Radiant Rare/i,
  /^LEGEND/i,
  /Illustration Rare/i,
  /Double Rare/i,
  /Ultra Rare/i,
  /Hyper Rare/i,
  /Shiny (Ultra )?Rare/i,
  /Special Illustration/i,
  /^ACE SPEC/i,
  /^Black White Rare/i,
  /^Trainer Gallery/i,
];

/** Reverse holos entered the game with Legendary Collection (2002-05-24). */
const REVERSE_HOLO_ERA_START = '2002/05/24';

/** Sets known not to have reverse holos despite falling inside the era. */
const NO_REVERSE_SETS = new Set([
  'mcd19', 'mcd18', 'mcd17', 'mcd16', 'mcd15', 'mcd14', 'mcd12', 'mcd11',
  'bp', 'si1', 'ru1', 'basep', 'np', 'sma', 'tk1a', 'tk1b', 'tk2a', 'tk2b',
]);

export function isHoloOnlyRarity(rarity: string | null | undefined): boolean {
  if (!rarity) return false;
  return HOLO_ONLY.some((re) => re.test(rarity));
}

export interface InferInput {
  rarity: string | null;
  setId: string;
  setReleaseDate: string | null; // 'YYYY/MM/DD'
}

/**
 * Whether a set is old enough for reverse holos to exist at all.
 *
 * This is a historical fact rather than a heuristic, which is why it is allowed
 * to override a price provider: a provider that labels a 1999 promo's foil
 * printing `reverseHolofoil` is using its own catalogue vocabulary, not
 * describing a card that was ever printed.
 *
 * It deliberately says nothing about rarity. Whether a given holo rare also had
 * a reverse holo printing varies by set, and there the provider knows better
 * than any rule we could write — so rarity only ever informs the fallback in
 * `inferVariants`, never a veto.
 */
export function reverseHoloEraAllows(setId: string, setReleaseDate: string | null): boolean {
  if (NO_REVERSE_SETS.has(setId)) return false;
  return !!setReleaseDate && setReleaseDate >= REVERSE_HOLO_ERA_START;
}

/**
 * Best-effort printing list for a card with no market coverage.
 * Returned variants are always tagged `inferred` by the caller.
 */
export function inferVariants({ rarity, setId, setReleaseDate }: InferInput): Variant[] {
  if (isHoloOnlyRarity(rarity)) return ['holofoil'];
  if (/promo/i.test(rarity ?? '')) return ['holofoil'];

  const inReverseEra =
    !!setReleaseDate && setReleaseDate >= REVERSE_HOLO_ERA_START && !NO_REVERSE_SETS.has(setId);

  return inReverseEra ? ['normal', 'reverseHolofoil'] : ['normal'];
}

/**
 * The printing a collector means when they say "I have that card" — the base
 * pull from a pack. Used as the default for main/complete set goals.
 */
export function primaryVariant(available: Variant[]): Variant {
  const order: Variant[] = [
    'normal',
    'holofoil',
    '1stEditionNormal',
    '1stEditionHolofoil',
    'unlimited',
    'unlimitedHolofoil',
    '1stEdition',
    'reverseHolofoil',
    // Shadowless never wins the primary slot — it is an added identity, not the
    // printing a main/complete goal is scored against.
    'shadowless',
    'shadowlessHolofoil',
  ];
  for (const v of order) if (available.includes(v)) return v;
  return available[0] ?? 'normal';
}
