import { describe, it, expect } from 'vitest';
import {
  variantLabel, variantShort, isVariantTokenShape, canonicaliseVariantToken,
  parseVariantToken, isTreatmentVariant, VARIANTS,
} from '@/lib/catalog/variants';
import { parseRows, serializeCollectionCsv, type ExportRow } from '@/lib/services/import';

/**
 * Application compatibility for the treatment identity axis (migration 0021).
 * Pure-logic proof (no DB) that the app now accepts, labels and round-trips
 * every treatment variant already present in production, and stays backward
 * compatible with the legacy base finishes.
 */

describe('variant token validation (issue 1: addable/removable)', () => {
  it('accepts base finishes (legacy) and finish__treatment tokens', () => {
    for (const v of VARIANTS) expect(isVariantTokenShape(v)).toBe(true);
    for (const t of [
      'holofoil__staff', 'holofoil__prerelease', 'holofoil__prerelease_staff',
      'reverseHolofoil__winner', 'normal__worlds', 'holofoil__cracked_ice',
      'holofoil__regional_championship', 'normal__prize_pack', 'holofoil__pokemon_center',
      'holofoil__league', 'normal__jumbo', 'holofoil__other_recognized',
    ]) expect(isVariantTokenShape(t)).toBe(true);
  });

  it('rejects garbage and unknown finishes', () => {
    for (const bad of ['', 'not a variant', 'bogusfinish__staff', 'holofoil__', '__staff', 'a'.repeat(90)]) {
      expect(isVariantTokenShape(bad)).toBe(false);
    }
  });

  it('parses a token into finish + treatment axes', () => {
    expect(parseVariantToken('holofoil__prerelease_staff')).toEqual({ finish: 'holofoil', treatment: 'prerelease_staff', language: 'EN' });
    expect(parseVariantToken('holofoil')).toEqual({ finish: 'holofoil', treatment: 'base', language: 'EN' });
    expect(isTreatmentVariant('holofoil__staff')).toBe(true);
    expect(isTreatmentVariant('holofoil')).toBe(false);
  });
});

describe('variant labels (issue 2: no blank printing labels)', () => {
  it('matches the required collector-facing labels', () => {
    expect(variantLabel('holofoil__staff')).toBe('Holofoil · Staff');
    expect(variantLabel('holofoil__prerelease')).toBe('Holofoil · Prerelease');
    expect(variantLabel('holofoil__prerelease_staff')).toBe('Holofoil · Prerelease Staff');
    expect(variantLabel('reverseHolofoil__winner')).toBe('Reverse Holofoil · Winner');
    expect(variantLabel('holofoil__cracked_ice')).toBe('Cracked Ice Holo');
    expect(variantLabel('holofoil__cosmos_holo')).toBe('Cosmos Holo');
  });

  it('labels every treatment already in production clearly', () => {
    expect(variantLabel('normal__worlds')).toBe('Normal · Worlds');
    expect(variantLabel('holofoil__national_championship')).toBe('Holofoil · National Championship');
    expect(variantLabel('holofoil__regional_championship')).toBe('Holofoil · Regional Championship');
    expect(variantLabel('normal__state_championship')).toBe('Normal · State Championship');
    expect(variantLabel('normal__prize_pack')).toBe('Normal · Prize Pack');
    expect(variantLabel('holofoil__league')).toBe('Holofoil · League');
    expect(variantLabel('holofoil__pokemon_center')).toBe('Holofoil · Pokémon Center');
    expect(variantLabel('normal__jumbo')).toBe('Normal · Jumbo');
    expect(variantLabel('holofoil__other_recognized')).toBe('Holofoil · Special Print');
  });

  it('keeps existing base printing labels unchanged', () => {
    expect(variantLabel('normal')).toBe('Normal');
    expect(variantLabel('holofoil')).toBe('Holo');
    expect(variantLabel('reverseHolofoil')).toBe('Reverse Holo');
    expect(variantLabel('1stEditionHolofoil')).toBe('1st Ed. Holo');
    expect(variantLabel('shadowlessHolofoil')).toBe('Shadowless Holo');
  });

  it('is never blank — an unknown treatment humanises rather than disappearing', () => {
    expect(variantLabel('holofoil__future_promo').length).toBeGreaterThan(0);
    expect(variantLabel('holofoil__future_promo')).toBe('Holofoil · Future Promo');
    expect(variantShort('holofoil__staff').length).toBeGreaterThan(0);
    expect(variantShort('reverseHolofoil__winner').length).toBeGreaterThan(0);
    expect(variantShort('holofoil')).toBe('HOLO');
  });
});

describe('CSV round-trip (issue 3: export → CSV → import preserves treatment)', () => {
  const rows: ExportRow[] = [
    { set_id: 'swshp', number: 'SWSH241', name: 'Gengar', variant: 'holofoil__staff', condition: 'NM', quantity: 1, paid_cents: null },
    { set_id: 'base3', number: '1', name: 'Aerodactyl', variant: 'holofoil__prerelease', condition: 'LP', quantity: 2, paid_cents: 8896 },
    { set_id: 'bp', number: '8', name: "Rocket's Mewtwo", variant: 'reverseHolofoil__winner', condition: 'NM', quantity: 1, paid_cents: null },
    { set_id: 'base1', number: '4', name: 'Charizard', variant: 'holofoil', condition: 'NM', quantity: 1, paid_cents: null }, // legacy base
  ];

  it('serialises and re-parses with the exact treatment token intact', () => {
    const csv = serializeCollectionCsv(rows);
    const { rows: parsed } = parseRows(csv);
    expect(parsed.map((r) => r.variant)).toEqual([
      'holofoil__staff', 'holofoil__prerelease', 'reverseHolofoil__winner', 'holofoil',
    ]);
    // and the surrounding fields survive too
    expect(parsed[0]!.numberHint).toBe('SWSH241');
    expect(parsed[1]!.quantity).toBe(2);
    expect(parsed[1]!.paidCents).toBe(8896);
  });

  it('canonicalises treatment tokens case-insensitively and legacy human aliases', () => {
    expect(canonicaliseVariantToken('reverseHolofoil__winner')).toBe('reverseHolofoil__winner');
    expect(canonicaliseVariantToken('REVERSEHOLOFOIL__WINNER')).toBe('reverseHolofoil__winner');
    expect(canonicaliseVariantToken('holofoil')).toBe('holofoil');
    expect(canonicaliseVariantToken('nonsense__x')).toBeNull();
  });
});

describe('legacy CSV compatibility (issue 3)', () => {
  it('reads a plain base-variant CSV exactly as before', () => {
    const csv = 'Set,Number,Name,Variant,Condition,Quantity\nbase1,4,Charizard,Reverse Holo,NM,1\nbase1,58,Pikachu,holofoil,LP,3';
    const { rows } = parseRows(csv);
    expect(rows[0]!.variant).toBe('reverseHolofoil'); // human alias still resolves
    expect(rows[1]!.variant).toBe('holofoil');
    expect(rows[1]!.quantity).toBe(3);
  });
});
