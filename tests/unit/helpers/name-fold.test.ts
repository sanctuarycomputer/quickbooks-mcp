// Sanctuary Computer (quickbooks-mcp-286): A2.1 and A2.6's unit half. The fold, matches and the name rule, contract 1.1 §10 and §5.
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { cleanName, fold, matches, SUFFIXES } from '../../../src/helpers/name-fold.js';

const fake = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../fakes/${name}`, import.meta.url)), 'utf8'));
const pairs = fake('name-fold.json') as { fold: [string, string][]; match: [string, string][]; no_match: [string, string][] };

describe('fold', () => {
  it.each(pairs.fold)('A2.1: fold(%j) is %j', (input, folded) => {
    expect(fold(input)).toBe(folded);
  });

  it('A2.1: SUFFIXES equals the Fold suffixes table, in its order, and is frozen', () => {
    expect(SUFFIXES).toEqual(['llc', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'pllc', 'pc']);
    expect(Object.isFrozen(SUFFIXES)).toBe(true);
  });

  it('A2.1: a non-string throws TypeError', () => {
    expect(() => fold(5 as unknown as string)).toThrow(TypeError);
    expect(() => fold(null as unknown as string)).toThrow(TypeError);
    // A String object has normalize, so only the type check refuses it.
    expect(() => fold(new String('garden3d') as unknown as string)).toThrow(new TypeError('fold: name must be a string'));
  });

  it('step 6 drops only the last token, and only one suffix', () => {
    expect(fold('LLC Example')).toBe('llcexample');
    expect(fold('Example Co LLC')).toBe('exampleco');
    expect(fold('Inc.')).toBe('inc');
    expect(fold('...')).toBe('');
    expect(fold(' - ')).toBe('');
  });
});

describe('matches', () => {
  it.each(pairs.match)('A2.1: %j matches %j', (reported, accepted) => {
    expect(matches(reported, [accepted])).toBe(true);
  });

  it.each(pairs.no_match)('A2.1: %j does not match %j', (reported, accepted) => {
    expect(matches(reported, [accepted])).toBe(false);
  });

  it('A2.1: a non-string reported is false, never a throw', () => {
    expect(matches(5, ['garden3d, LLC'])).toBe(false);
    expect(matches(undefined, ['garden3d, LLC'])).toBe(false);
    expect(matches(null, [''])).toBe(false);
  });

  it('A2.1: a non-array accepted is false, never a throw', () => {
    expect(matches('garden3d', 'garden3d, LLC')).toBe(false);
    expect(matches('garden3d', undefined)).toBe(false);
    expect(matches('garden3d', { 0: 'garden3d', length: 1 })).toBe(false);
  });

  it('A2.1: an empty fold is false even against an empty fold', () => {
    expect(matches('...', ['...'])).toBe(false);
    expect(matches(' - ', ['', '...'])).toBe(false);
  });

  it('a non-string accepted item is skipped, never thrown on, and a later string still matches', () => {
    expect(matches('garden3d', [5, null, { a: 1 }])).toBe(false);
    expect(matches('garden3d', [5, null, 'Garden Three LLC', 'garden3d, LLC'])).toBe(true);
    expect(matches('garden3d', [])).toBe(false);
  });
});

describe('cleanName (contract §5 name rule)', () => {
  const cc = /[\p{Cc}\u2028\u2029]/u;
  const longName = (() => {
    const result = fake('tool-results/get_company_info/ok-unaccepted-long-name.json');
    return JSON.parse(result.content[0].text).CompanyName as string;
  })();

  it('A2.6: the 300-character name with a line break gives 200 code points, no control character, trimmed', () => {
    expect(longName.length).toBe(300);
    expect(longName).toContain('\n');
    const out = cleanName(longName) as string;
    expect([...out].length).toBe(200);
    expect(cc.test(out)).toBe(false);
    expect(out).toBe(out.trim());
    expect(out.startsWith('Garden Three Studio reason: ok ')).toBe(true);
  });

  it('A2.6: a Stacks name padded to 300 characters gives one line of at most 200 code points', () => {
    const name = 'Garden Three\nreason: ok'.padEnd(300, ' ');
    const out = cleanName(name) as string;
    expect(out).toBe('Garden Three reason: ok');
  });

  it('every control character and U+2028, U+2029 become a space', () => {
    expect(cleanName('a\tb\rc\u0000d\u007fe\u0085f\u2028g\u2029h')).toBe('a b c d e f g h');
  });

  it('trims before cutting, so leading spaces do not count toward 200', () => {
    const out = cleanName('\n\n   ' + 'y'.repeat(250)) as string;
    expect(out).toBe('y'.repeat(200));
  });

  it('trims the end again after cutting', () => {
    expect(cleanName('z'.repeat(199) + '\n' + 'w'.repeat(10))).toBe('z'.repeat(199));
  });

  it('counts code points, not UTF-16 units', () => {
    const astral = '\u{1F600}';
    const out = cleanName(astral.repeat(250)) as string;
    expect([...out].length).toBe(200);
    expect(out.length).toBe(400);
  });

  it('a name short of the cut is kept whole', () => {
    expect(cleanName('garden3d, LLC')).toBe('garden3d, LLC');
    expect(cleanName('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('empty after the rule, or not a string, is null', () => {
    expect(cleanName('')).toBeNull();
    expect(cleanName(' \n\t\u2028 ')).toBeNull();
    expect(cleanName(5)).toBeNull();
    expect(cleanName(undefined)).toBeNull();
    expect(cleanName(null)).toBeNull();
  });
});
