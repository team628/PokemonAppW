/**
 * Card condition — pure domain data, safe to import from client components.
 *
 * Kept out of the service layer deliberately: the moment a UI component imports
 * a constant from a module that also opens the database, the whole persistence
 * layer follows it into the browser bundle.
 */

export const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONDITION_LABEL: Record<Condition, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DMG: 'Damaged',
};

/**
 * Market prices are quoted for Near Mint. Anything else trades at a discount,
 * and pretending otherwise would inflate every played card in a collection.
 * These are the widely used trade-in bands — estimates, and labelled as such
 * wherever a non-NM card contributes to a total.
 */
export const CONDITION_MULTIPLIER: Record<Condition, number> = {
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.5,
  DMG: 0.3,
};
