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
