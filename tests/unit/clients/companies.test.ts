// Sanctuary Computer (quickbooks-mcp-286): A2.7's parser half and A2.8's refusals. parseCompanies reads a QBO_COMPANIES file's text (contract 1.1 §2 Keys, §3).
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseCompanies } from '../../../src/clients/companies.js';
import { fold } from '../../../src/helpers/name-fold.js';

const fakeText = (name: string) => readFileSync(fileURLToPath(new URL(`../../fakes/${name}`, import.meta.url)), 'utf8');
const pairs = JSON.parse(fakeText('name-fold.json')) as { fold: [string, string][] };

type Entry = { stacks_key?: unknown; name?: unknown; accepted_names?: unknown };
const entry = (stacks_key: string, name: string, ...more: string[]): Entry => ({ stacks_key, name, accepted_names: [name, ...more] });
const file = (companies: unknown, v: unknown = '1.0') => JSON.stringify({ v, companies });
const base = (): Entry[] => [entry('sanctuary-computer', 'Sanctuary Computer Inc'), entry('garden3d', 'garden3d, LLC')];

/** Expects parseCompanies to throw `QBO_COMPANIES <reason>`, and the message to carry none of the file's values. */
function refuses(text: string, reason: string, values: string[] = []): void {
  let err: unknown;
  try {
    parseCompanies(text);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message).toBe(`QBO_COMPANIES ${reason}`);
  for (const v of values) expect(message).not.toContain(v);
}

describe('parseCompanies: the files', () => {
  it('A2.7: entities.json gives the four keys in order with names and accepted names', () => {
    expect(parseCompanies(fakeText('entities.json'))).toEqual([
      { key: 'sanctuary-computer', name: 'Sanctuary Computer Inc', acceptedNames: ['Sanctuary Computer Inc'] },
      { key: 'garden3d', name: 'garden3d, LLC', acceptedNames: ['garden3d, LLC'] },
      { key: 'index-space', name: 'Index Space, LLC', acceptedNames: ['Index Space, LLC'] },
      { key: 'usb-club', name: 'USB Club, LLC', acceptedNames: ['USB Club, LLC'] },
    ]);
  });

  it('A2.7: entities-two.json gives its companies, garden3d with the added name', () => {
    const two = parseCompanies(fakeText('entities-two.json'));
    expect(two.map((c) => c.key)).toEqual(['sanctuary-computer', 'garden3d', 'index-space', 'usb-club', 'north-fork']);
    expect(two[1]).toEqual({ key: 'garden3d', name: 'garden3d, LLC', acceptedNames: ['garden3d, LLC', 'Garden Three LLC'] });
  });

  it('T1-5: Garden Three LLC folds as name-fold.json says a suffix folds, to its own key, and the overlap equals entities.json', () => {
    // name-fold.json: "Example Works LLC" -> "exampleworks", so a trailing LLC drops; "Garden Three" folds as two plain tokens.
    expect(pairs.fold).toContainEqual(['Example Works LLC', 'exampleworks']);
    expect(fold('Garden Three LLC')).toBe('gardenthree');
    expect(fold('Garden Three LLC')).toBe(fold('Garden Three'));
    const one = parseCompanies(fakeText('entities.json'));
    const two = parseCompanies(fakeText('entities-two.json'));
    // Garden Three LLC is garden3d's accepted name, so a reported "Garden Three" matches garden3d (A2.2's call) and no other company.
    const owners = two.filter((c) => c.acceptedNames.some((a) => fold(a) === fold('Garden Three')));
    expect(owners.map((c) => c.key)).toEqual(['garden3d']);
    for (const c of one) {
      const other = two.find((t) => t.key === c.key);
      if (c.key === 'garden3d') expect(other).toEqual({ ...c, acceptedNames: [...c.acceptedNames, 'Garden Three LLC'] });
      else expect(other).toEqual(c);
    }
  });

  it('a 1.0.x patch version is accepted', () => {
    expect(parseCompanies(file(base(), '1.0.3')).map((c) => c.key)).toEqual(['sanctuary-computer', 'garden3d']);
  });

  it('A2.8: Inc. folds to inc and is accepted', () => {
    expect(parseCompanies(file([entry('a', 'Inc.')]))).toEqual([{ key: 'a', name: 'Inc.', acceptedNames: ['Inc.'] }]);
  });

  it('A2.8: two accepted names of one company folding alike are accepted', () => {
    const out = parseCompanies(file([entry('garden3d', 'garden3d, LLC', 'Garden3D LLC', 'GARDEN3D'), entry('usb-club', 'USB Club, LLC')]));
    expect(out[0].acceptedNames).toEqual(['garden3d, LLC', 'Garden3D LLC', 'GARDEN3D']);
  });

  it('the result is a copy the caller cannot change', () => {
    const out = parseCompanies(file(base()));
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out[0])).toBe(true);
    expect(Object.isFrozen(out[0].acceptedNames)).toBe(true);
  });
});

describe('parseCompanies: A2.8 refusals', () => {
  it('not JSON', () => {
    refuses('', 'is not JSON');
    refuses('{"v": "1.0", "companies": [', 'is not JSON', ['companies']);
    refuses('Sanctuary Computer Inc', 'is not JSON', ['Sanctuary']);
  });

  it('wrong shape: not an object', () => {
    refuses('null', 'is not an object');
    refuses('[]', 'is not an object');
    refuses('"1.0"', 'is not an object');
  });

  it('wrong shape: v missing or not 1.0', () => {
    refuses(JSON.stringify({ companies: base() }), 'has no v 1.0');
    refuses(file(base(), 1), 'has no v 1.0');
    refuses(file(base(), '2.0'), 'has no v 1.0', ['2.0']);
    refuses(file(base(), '1.1'), 'has no v 1.0', ['1.1']);
    refuses(file(base(), '1.0.'), 'has no v 1.0');
    refuses(file(base(), 'v1.0'), 'has no v 1.0');
  });

  it('wrong shape: companies not an array', () => {
    refuses(JSON.stringify({ v: '1.0' }), 'companies is not an array');
    refuses(file({ 0: entry('a', 'A') }), 'companies is not an array');
  });

  it('no companies', () => {
    refuses(file([]), 'has no companies');
  });

  it('an entry not an object', () => {
    refuses(file([...base(), null]), 'has a company that is not an object');
    refuses(file([...base(), ['x']]), 'has a company that is not an object');
  });

  it('an entry missing a field, or a field of the wrong type', () => {
    const cases: [Entry, string][] = [
      [{ name: 'X', accepted_names: ['X'] }, 'stacks_key'],
      [{ stacks_key: '', name: 'X', accepted_names: ['X'] }, 'stacks_key'],
      [{ stacks_key: 5, name: 'X', accepted_names: ['X'] }, 'stacks_key'],
      [{ stacks_key: 'x', accepted_names: ['X'] }, 'name'],
      [{ stacks_key: 'x', name: '', accepted_names: [''] }, 'name'],
      [{ stacks_key: 'x', name: 7, accepted_names: [7] }, 'name'],
      [{ stacks_key: 'x', name: 'X' }, 'accepted_names'],
      [{ stacks_key: 'x', name: 'X', accepted_names: 'X' }, 'accepted_names'],
      [{ stacks_key: 'x', name: 'X', accepted_names: [] }, 'accepted_names'],
      [{ stacks_key: 'x', name: 'X', accepted_names: ['X', 5] }, 'accepted_names'],
    ];
    for (const [e, field] of cases) refuses(file([...base(), e]), `has a company with no valid ${field}`, ['X']);
  });

  it('a repeated stacks_key', () => {
    refuses(file([...base(), entry('garden3d', 'Other Studio')]), 'repeats a stacks_key', ['garden3d', 'Other']);
  });

  it('accepted_names[0] is not name', () => {
    refuses(file([{ stacks_key: 'x', name: 'North Fork', accepted_names: ['North Fork Studio', 'North Fork'] }]), 'has a company whose accepted_names[0] is not its name', ['North']);
  });

  it('an accepted name that folds to an empty key, at accepted_names[0] or later', () => {
    refuses(file([entry('x', '...')]), 'has an accepted name that folds to an empty key', ['...']);
    refuses(file([...base(), entry('x', 'North Fork', '...')]), 'has an accepted name that folds to an empty key', ['North']);
    refuses(file([entry('x', 'North Fork', 'North Fork LLC', ' - ')]), 'has an accepted name that folds to an empty key');
    refuses(file([entry('x', 'North Fork', ''), ...base()]), 'has an accepted name that folds to an empty key');
  });

  it('two companies whose accepted names fold to one key, every name of one against every name of each other', () => {
    const msg = 'has two companies whose accepted names fold to the same key';
    // name against name
    refuses(file([entry('garden3d', 'garden3d'), entry('other', 'Garden3D LLC')]), msg, ['garden3d', 'Garden3D']);
    // a later name of the second against the first's name
    refuses(file([...base(), entry('other', 'Other Studio', 'Garden3D LLC')]), msg, ['Garden3D', 'Other']);
    // a later name of the first against a later name of a non-adjacent third
    refuses(
      file([entry('a', 'Alpha', 'Shared Name Inc'), entry('b', 'Beta'), entry('c', 'Gamma', 'Gamma Two', 'shared-name')]),
      msg,
      ['Shared', 'shared'],
    );
  });
});
