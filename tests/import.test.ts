import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from '@/lib/db';
import { matchRows, parseCsv, parseRows } from '@/lib/services/import';

describe('parseCsv', () => {
  it('reads a plain table', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('respects quoted fields containing commas', () => {
    expect(parseCsv('name,set\n"Charizard, Dark",Team Rocket')).toEqual([
      ['name', 'set'],
      ['Charizard, Dark', 'Team Rocket'],
    ]);
  });

  it('handles escaped quotes and CRLF line endings', () => {
    expect(parseCsv('a\r\n"say ""hi"""')).toEqual([['a'], ['say "hi"']]);
  });

  it('drops blank lines rather than emitting empty rows', () => {
    expect(parseCsv('a,b\n\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('parseRows', () => {
  it('recognises common header spellings across exports', () => {
    const { rows, recognised } = parseRows(
      'Set Name,Card Number,Product Name,Qty,Condition,Printing,Purchase Price\nBase,4,Charizard,2,Lightly Played,Holofoil,$220.00',
    );
    expect(recognised).toEqual(expect.arrayContaining(['set', 'number', 'name', 'quantity', 'condition', 'variant', 'price']));
    const r = rows[0]!;
    expect(r.setHint).toBe('Base');
    expect(r.numberHint).toBe('4');
    expect(r.quantity).toBe(2);
    expect(r.condition).toBe('LP');
    expect(r.variant).toBe('holofoil');
    expect(r.paidCents).toBe(22000);
  });

  it('takes the left side of a fractional card number', () => {
    expect(parseRows('Set,Number\nBase,4/102').rows[0]!.numberHint).toBe('4');
    expect(parseRows('Set,Number\n151,SV049/SV122').rows[0]!.numberHint).toBe('SV049');
  });

  it('strips a leading hash from card numbers', () => {
    expect(parseRows('Set,Number\nBase,#25').rows[0]!.numberHint).toBe('25');
  });

  it('defaults quantity to one and never to zero or negative', () => {
    expect(parseRows('Set,Number,Qty\nBase,4,').rows[0]!.quantity).toBe(1);
    expect(parseRows('Set,Number,Qty\nBase,4,0').rows[0]!.quantity).toBe(1);
    expect(parseRows('Set,Number,Qty\nBase,4,-5').rows[0]!.quantity).toBe(1);
  });

  it('falls back to Near Mint on unrecognised condition wording', () => {
    // Guessing a discount from wording we do not understand would quietly
    // deflate the collection's value.
    expect(parseRows('Set,Number,Condition\nBase,4,pristine-ish').rows[0]!.condition).toBe('NM');
    expect(parseRows('Set,Number,Condition\nBase,4,Moderately Played').rows[0]!.condition).toBe('MP');
    expect(parseRows('Set,Number,Condition\nBase,4,HP').rows[0]!.condition).toBe('HP');
  });

  it('leaves the printing unset when the column says nothing useful', () => {
    expect(parseRows('Set,Number,Printing\nBase,4,').rows[0]!.variant).toBeNull();
    expect(parseRows('Set,Number,Printing\nBase,4,Reverse Holo').rows[0]!.variant).toBe('reverseHolofoil');
  });
});

const DB_PATH = path.join(process.cwd(), 'data', 'setvalue.db');
const hasData = existsSync(DB_PATH);
const describeData = hasData ? describe : describe.skip;

let db: DB | undefined;
if (hasData) db = openDb(DB_PATH);
afterAll(() => db?.close());

const match = (csv: string) => matchRows(db!, parseRows(csv).rows);

describeData('matchRows against the real catalog', () => {
  it('resolves a row by set name and card number', () => {
    const r = match('Set,Number,Qty\nBase,4,1').rows[0]!;
    expect(r.confidence).toBe('exact');
    expect(r.cardId).toBe('base1-4');
    expect(r.cardName).toBe('Charizard');
  });

  it('resolves by set code and by set id as well as by name', () => {
    expect(match('Set,Number\nbase1,4').rows[0]!.cardId).toBe('base1-4');
    expect(match('Set,Number\nBS,4').rows[0]!.cardId).toBe('base1-4');
  });

  it('picks the card’s real printing, not a printing that does not exist', () => {
    // Base Set has no reverse holos; asking for one must not invent a slot.
    const r = match('Set,Number,Printing\nBase,4,Reverse Holo').rows[0]!;
    expect(r.confidence).toBe('exact');
    expect(r.resolvedVariant).toBe('holofoil');
    expect(r.reason).toMatch(/no reverseHolofoil printing/);
  });

  it('honours a stated printing the card actually has', () => {
    const r = match('Set,Number,Printing\n151,1,Reverse Holo').rows[0]!;
    expect(r.resolvedVariant).toBe('reverseHolofoil');
  });

  it('refuses a card name that appears in many sets', () => {
    const r = match('Name,Qty\nPikachu,1').rows[0]!;
    expect(r.confidence).toBe('ambiguous');
    expect(r.candidates!.length).toBeGreaterThan(1);
    expect(r.reason).toMatch(/several sets/);
  });

  it('accepts a name once a set narrows it to one card', () => {
    const r = match('Set,Name\nBase,Charizard').rows[0]!;
    expect(r.confidence).toBe('exact');
    expect(r.cardId).toBe('base1-4');
  });

  it('reports an unknown card number instead of silently skipping it', () => {
    const r = match('Set,Number\nBase,9999').rows[0]!;
    expect(r.confidence).toBe('unmatched');
    expect(r.reason).toMatch(/No card numbered 9999/);
  });

  it('reports a row with nothing to match on', () => {
    const r = match('Set,Qty\nBase,3').rows[0]!;
    expect(r.confidence).toBe('unmatched');
    expect(r.reason).toMatch(/no card number or name/);
  });

  it('counts matched, ambiguous and unmatched rows separately', () => {
    const result = match(
      ['Set,Number,Name,Qty', 'Base,4,Charizard,1', 'Base,9999,Nonsense,1', ',,Pikachu,1'].join('\n'),
    );
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.ambiguous).toBe(1);
    expect(result.totalQuantity).toBe(1); // only matched rows count toward the import
  });

  it('handles a large file without choking', () => {
    const lines = ['Set,Number,Qty'];
    for (let i = 1; i <= 102; i++) lines.push(`Base,${i},1`);
    const result = match(lines.join('\n'));
    expect(result.matched).toBe(102);
    expect(result.totalQuantity).toBe(102);
  });
});
