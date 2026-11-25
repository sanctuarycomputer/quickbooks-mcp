// Sanctuary Computer (quickbooks-mcp-293): A4.1-A4.5. The digests and the compare, contract 1.1 §17 (docs/contracts/quickbooks.md in Stacksbot).
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { canonicalJson, sha256Hex } from '../../src/write/canonical.js';
import { compare, compareDigests, digests, resolveChanges, type Change } from '../../src/write/compare.js';

type Txn = Record<string, any>;
const HOME = 'docs/contracts/quickbooks/transactions/';
const at = (rel: string) => fileURLToPath(new URL(`../fakes/transactions/${rel}`, import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(at(rel), 'utf8'));
const entity = (body: Txn): Txn => body.Purchase ?? body.Bill;
const copy = (txn: Txn): Txn => JSON.parse(JSON.stringify(txn));

const FETCHED = entity(read('fetched/purchase-1001.json'));
const SENT = entity(read('answers/update-sent.json').body);
const CHANGES = read('cases/account-and-class.json').params.lines as Change[];

/** Both compares, in memory and through stored digests (a JSON round trip, as the ledger keeps them); they must agree. */
function both(stored: Txn, fetched: Txn, changes: Change[]) {
  const inMemory = compare(stored, fetched, changes);
  const kept = JSON.parse(JSON.stringify(digests(fetched, changes.map((c) => c.line_id))));
  expect(compareDigests(stored, kept, resolveChanges(fetched, changes))).toEqual(inMemory);
  return inMemory;
}
/** The names both compares give for the sent copy after `edit`. */
function names(edit: (stored: Txn) => void, fetched = FETCHED, changes = CHANGES, from = SENT): string[] {
  const stored = copy(from);
  edit(stored);
  const out = both(stored, fetched, changes);
  return out.same ? [] : out.fields;
}
const detail = (line: Txn): Txn => line.AccountBasedExpenseLineDetail;

describe('canonicalJson and sha256Hex', () => {
  it('sorts keys by UTF-16 code unit at every depth, without white space, and keeps array order', () => {
    const value = { b: [{ z: 1, a: 'x y' }, 2, 1], a: { '10': 1, '9': 2, B: 3, a: null, 'é': true } };
    expect(canonicalJson(value)).toBe('{"a":{"10":1,"9":2,"B":3,"a":null,"é":true},"b":[{"a":"x y","z":1},2,1]}');
    // A surrogate pair sorts before U+FF5E by code unit, after it by code point.
    expect(canonicalJson({ '～': 1, '\u{1f600}': 2 })).toBe('{"\u{1f600}":2,"～":1}');
  });

  it('otherwise reads as JSON.stringify does', () => {
    const value = { a: undefined, b: [undefined, NaN, -0], c: new Date(0), d: '"\n\ud800', 'e"': 1 };
    expect(canonicalJson(value)).toBe(JSON.stringify(value));
    for (const v of [null, true, 'x', 1.5, [], {}]) expect(canonicalJson(v)).toBe(JSON.stringify(v));
  });

  it('keeps an own __proto__ key', () => {
    expect(canonicalJson(JSON.parse('{"b":1,"__proto__":{"y":1,"x":2}}'))).toBe('{"__proto__":{"x":2,"y":1},"b":1}');
  });

  it('refuses a value that has no JSON', () => {
    expect(() => canonicalJson(undefined)).toThrow(new TypeError('canonicalJson: the value has no JSON'));
  });

  it('sha256Hex is the lowercase hex of the UTF-8 bytes', () => {
    // The contract's Digest example: Id 1001 hashes its canonical JSON.
    expect(sha256Hex('"1001"')).toBe('a0064c86a582fa64f14c66f6b43708d60e1bdb791ac2acfa332d059895c265f9');
    expect(sha256Hex('é')).toBe(sha256Hex(Buffer.from([0xc3, 0xa9]).toString('utf8')));
    expect(sha256Hex('é')).toMatch(/^4a99557e/);
  });
});

describe('digests', () => {
  it("the contract's Digest example, exactly", () => {
    const txn = JSON.parse(
      '{ "Id": "1001", "SyncToken": "3", "TxnDate": "2026-11-10", "PaymentType": "CreditCard", "TotalAmt": 120, "MetaData": { "CreateTime": "2026-11-10T09:00:00-08:00" }, "Line": [ { "Id": "1", "Amount": 100, "DetailType": "AccountBasedExpenseLineDetail", "AccountBasedExpenseLineDetail": { "AccountRef": { "value": "77" } } }, { "Id": "2", "Amount": 20, "DetailType": "AccountBasedExpenseLineDetail", "AccountBasedExpenseLineDetail": { "AccountRef": { "value": "84" }, "ClassRef": { "value": "12" } } } ] }',
    );
    expect(digests(txn, new Set(['1']))).toEqual({
      Id: 'a0064c86a582fa64f14c66f6b43708d60e1bdb791ac2acfa332d059895c265f9',
      Line: 'cc3f2a1ffd63c4db19e0114b93a94b774e4a2d07a2a5ec5b193303ac1387d633',
      'Line:1': '44a7fce95e5c1f409da8d7193091845900bf9ea9a5057134236c05fe3f719428',
      'Line:2': '4510a18193cfae65fa63ab147c8b473d27166b8a3a19b79636d039029d4852e1',
      PaymentType: 'e28ab3299eec22d2e89df4e9ed8f93899e26355dd049cd3954c444fc66eac8bd',
      TotalAmt: '2abaca4911e68fa9bfbf3482ee797fd5b9045b841fdff7253557c5fe15de6477',
      TxnDate: 'f67c5ec50bf3ce9b5e2e30b3b2ba5789ee3f1491778fd8b3b94147e12dbc2a81',
    });
  });

  const cases = readdirSync(at('cases')).sort();
  it('there are seven cases', () => expect(cases).toHaveLength(7));

  it.each(cases)('A4.1: %s', (file) => {
    const c = read(`cases/${file}`);
    const named = ((c.intent ?? c.params).lines as Change[]).map((l) => l.line_id);
    expect(c.fetched.startsWith(HOME)).toBe(true);
    const txn = entity(read(c.fetched.slice(HOME.length)));
    const before = copy(txn);
    expect(digests(txn, named)).toEqual(c.digests);
    expect(txn).toEqual(before);
  });

  it('leaves out SyncToken, MetaData and sparse, and keeps every other top-level field', () => {
    const txn = { SyncToken: '1', MetaData: {}, sparse: true, domain: 'QBO', Line: [] };
    expect(Object.keys(digests(txn, [])).sort()).toEqual(['Line', 'domain']);
  });

  it('a named line keeps every other part of its detail, and other details are left whole', () => {
    const line = (d: Txn, other: Txn) => ({ Line: [{ Id: '1', AccountBasedExpenseLineDetail: d, ItemBasedExpenseLineDetail: other }] });
    const base = digests(line({ AccountRef: 1, ClassRef: 2, TaxCodeRef: 3 }, { ClassRef: 4 }), ['1'])['Line:1'];
    expect(digests(line({ AccountRef: 8, ClassRef: 9, TaxCodeRef: 3 }, { ClassRef: 4 }), ['1'])['Line:1']).toBe(base);
    expect(digests(line({ TaxCodeRef: 3 }, { ClassRef: 4 }), ['1'])['Line:1']).toBe(base);
    expect(digests(line({ TaxCodeRef: 5 }, { ClassRef: 4 }), ['1'])['Line:1']).not.toBe(base);
    expect(digests(line({ TaxCodeRef: 3 }, { ClassRef: 5 }), ['1'])['Line:1']).not.toBe(base);
  });

  it('a named line without an account-based detail is hashed as it is', () => {
    const line = { Id: '1', Amount: 5 };
    expect(digests({ Line: [line] }, ['1'])['Line:1']).toBe(sha256Hex(canonicalJson(line)));
    const nulled = { Id: '1', AccountBasedExpenseLineDetail: null };
    expect(digests({ Line: [nulled] }, ['1'])['Line:1']).toBe(sha256Hex(canonicalJson(nulled)));
  });

  it('a line that has no string Id, or is no object, has no key of its own; a transaction without Line has no lines', () => {
    const d = digests({ Line: [{ Amount: 1 }, { Id: 7 }, null, 'x'] }, []);
    expect(Object.keys(d)).toEqual(['Line']);
    expect(d.Line).toBe(sha256Hex('[null,7,null,null]'));
    expect(digests({}, [])).toEqual({ Line: sha256Hex('[]') });
  });

  it('an own __proto__ key is hashed as any other, at the top and in a named line and its detail', () => {
    const d = digests(JSON.parse('{"__proto__":{"polluted":1},"Line":[]}'), []);
    expect(Object.keys(d).sort()).toEqual(['Line', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(d, '__proto__')?.value).toBe(sha256Hex('{"polluted":1}'));
    expect(({} as Txn).polluted).toBeUndefined();
    const line = '{"AccountBasedExpenseLineDetail":{"__proto__":{"b":1}},"Id":"1","__proto__":{"a":1}}';
    expect(digests(JSON.parse(`{"Line":[${line}]}`), ['1'])['Line:1']).toBe(sha256Hex(canonicalJson(JSON.parse(line))));
  });
});

describe('resolveChanges', () => {
  it('an absent class_id is the fetched class or null; null and a value stay', () => {
    const change = (line_id: string, class_id?: string | null): Change => ({ line_id, account_id: '91', ...(class_id === undefined ? {} : { class_id }) });
    const got = resolveChanges(FETCHED, [change('1'), change('2'), change('2', null), change('1', '13'), change('9')]);
    expect(got).toEqual([
      { line_id: '1', account_id: '91', class_id: null },
      { line_id: '2', account_id: '91', class_id: '12' },
      { line_id: '2', account_id: '91', class_id: null },
      { line_id: '1', account_id: '91', class_id: '13' },
      { line_id: '9', account_id: '91', class_id: null },
    ]);
  });

  it('a fetched class that is no string is null', () => {
    const fetched = { Line: [{ Id: '1', AccountBasedExpenseLineDetail: { ClassRef: { value: 12 } } }] };
    expect(resolveChanges(fetched, [{ line_id: '1', account_id: '84' }])).toEqual([{ line_id: '1', account_id: '84', class_id: null }]);
  });
});

describe('compare and compareDigests', () => {
  it('A4.2: the sent answer is the same both ways', () => {
    expect(both(SENT, FETCHED, CHANGES)).toEqual({ same: true });
  });

  it('unsorted keys give the same digests', () => {
    const reversed = (v: any): any =>
      Array.isArray(v) ? v.map(reversed) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v;
    const stored = reversed(SENT);
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(SENT));
    expect(digests(stored, ['1'])).toEqual(digests(SENT, ['1']));
    expect(both(stored, FETCHED, CHANGES)).toEqual({ same: true });
  });

  const STORED: Record<string, string> = {
    'stored-amount.json': 'Line:1',
    'stored-dropped-line.json': 'Line:2',
    'stored-header.json': 'PaymentType',
    'stored-unnamed-account.json': 'Line:2',
  };
  it('every stored-*.json has its case', () => {
    expect(readdirSync(at('answers')).filter((f) => f.startsWith('stored-')).sort()).toEqual(Object.keys(STORED));
  });
  it.each(Object.entries(STORED))('A4.3: %s names only %s', (file, field) => {
    expect(both(entity(read(`answers/${file}`).body), FETCHED, CHANGES)).toEqual({ same: false, fields: [field] });
  });

  it('A4.4: a named line that kept the ClassRef the change clears', () => {
    const changes = read('cases/class-cleared.json').params.lines as Change[];
    expect(names(() => {}, FETCHED, changes, FETCHED)).toEqual(['Line:2.ClassRef']);
    expect(names((t) => delete detail(t.Line[1]).ClassRef, FETCHED, changes, FETCHED)).toEqual([]);
  });

  it("A4.4: a named line whose AccountRef isn't the intended after", () => {
    expect(names((t) => (detail(t.Line[0]).AccountRef = { value: '77' }))).toEqual(['Line:1.AccountRef']);
    expect(names((t) => delete detail(t.Line[0]).AccountRef)).toEqual(['Line:1.AccountRef']);
    expect(names((t) => (detail(t.Line[0]).AccountRef = { value: '84', name: 'Software' }))).toEqual([]);
  });

  it('A4.4: a named line that gained a ClassRef where none was asked for and none was there', () => {
    const changes: Change[] = [{ line_id: '1', account_id: '84' }];
    expect(names(() => {}, FETCHED, changes)).toEqual(['Line:1.ClassRef']);
    expect(names((t) => delete detail(t.Line[0]).ClassRef, FETCHED, changes)).toEqual([]);
  });

  it.each([null, {}, { name: 'x' }, { value: null, name: 'x' }, { value: 12 }, [], 'x'])('TA2: a present ClassRef with no string value matches no class: %j', (ref) => {
    for (const class_id of [null, '12']) {
      expect(names((t) => (detail(t.Line[0]).ClassRef = ref), FETCHED, [{ line_id: '1', account_id: '84', class_id }])).toEqual(['Line:1.ClassRef']);
    }
  });

  it.each([null, {}, { value: null }, { value: 84 }, '84'])('TA2, TA5: an AccountRef with no string value matches no account: %j', (ref) => {
    expect(names((t) => (detail(t.Line[0]).AccountRef = ref))).toEqual(['Line:1.AccountRef']);
  });

  it('A4.4: a named line whose class is another than the given one', () => {
    expect(names((t) => (detail(t.Line[0]).ClassRef = { value: '13' }))).toEqual(['Line:1.ClassRef']);
    expect(names((t) => delete detail(t.Line[0]).ClassRef)).toEqual(['Line:1.ClassRef']);
  });

  it('a kept ref names the ref: the stored copy lost the class the change kept', () => {
    const changes = read('cases/account-keeps-class.json').params.lines as Change[];
    const sent = (t: Txn) => (detail(t.Line[1]).AccountRef = { value: '91' });
    expect(names(sent, FETCHED, changes, FETCHED)).toEqual([]);
    expect(names((t) => (sent(t), delete detail(t.Line[1]).ClassRef), FETCHED, changes, FETCHED)).toEqual(['Line:2.ClassRef']);
    expect(names(() => {}, FETCHED, changes, FETCHED)).toEqual(['Line:2.AccountRef']);
  });

  it('A4.5: an added top-level field, and a removed one', () => {
    expect(names((t) => (t.PrivateNote = 'x'))).toEqual(['PrivateNote']);
    expect(names((t) => delete t.PaymentType)).toEqual(['PaymentType']);
  });

  it('A4.5: an added line is named once, without Line', () => {
    expect(names((t) => t.Line.push({ Id: '3', Amount: 1 }))).toEqual(['Line:3']);
  });

  it("A4.5: a named line's Amount, and its Description", () => {
    expect(names((t) => (t.Line[0].Amount = 99))).toEqual(['Line:1']);
    expect(names((t) => (t.Line[0].Description = 'x'))).toEqual(['Line:1']);
  });

  it("a changed transaction amount names TotalAmt, and an unnamed line's class its line", () => {
    expect(names((t) => (t.TotalAmt = 121))).toEqual(['TotalAmt']);
    expect(names((t) => delete detail(t.Line[1]).ClassRef)).toEqual(['Line:2']);
  });

  it('two lines swapped name only Line', () => {
    expect(names((t) => t.Line.reverse())).toEqual(['Line']);
    // A field on one side only is no line, so it doesn't account for the order.
    expect(names((t) => (t.Line.reverse(), (t.PrivateNote = 'x')))).toEqual(['Line', 'PrivateNote']);
  });

  it('a dropped line and two others swapped name only the dropped line', () => {
    const three = copy(FETCHED);
    three.Line.push({ Id: '3', Amount: 1 });
    expect(names((t) => (t.Line = [t.Line[1], t.Line[0]]), three)).toEqual(['Line:3']);
  });

  it('fails closed on Line: a repeated line id, a line with no Id, a swap beside a changed line', () => {
    expect(names((t) => t.Line.push(copy(t.Line[1])))).toEqual(['Line']);
    expect(names((t) => t.Line.push({ Amount: 5 }))).toEqual(['Line']);
    expect(names((t) => t.Line.push(null))).toEqual(['Line']);
    // A changed line present on both sides doesn't account for the order.
    expect(names((t) => (t.Line.reverse(), (t.Line[0].Amount = 21)))).toEqual(['Line', 'Line:2']);
  });

  it('every copy of a repeated named line has its refs checked', () => {
    const bad = (t: Txn) => {
      const extra = copy(t.Line[0]);
      detail(extra).AccountRef = { value: '77' };
      return extra;
    };
    expect(names((t) => t.Line.push(bad(t)))).toEqual(['Line', 'Line:1.AccountRef']);
    expect(names((t) => t.Line.unshift(bad(t)))).toEqual(['Line', 'Line:1.AccountRef']);
  });

  it('a named line missing from the stored copy is named only as Line:<Id>', () => {
    expect(names((t) => t.Line.shift())).toEqual(['Line:1']);
    expect(names((t) => delete t.Line)).toEqual(['Line:1', 'Line:2']);
    // On neither side: the change did not land anywhere.
    expect(names(() => {}, FETCHED, [...CHANGES, { line_id: '9', account_id: '84' }])).toEqual(['Line:9']);
    // A swap beside it is still named: no line is on one side only.
    expect(names((t) => t.Line.reverse(), FETCHED, [...CHANGES, { line_id: '9', account_id: '84' }])).toEqual(['Line', 'Line:9']);
  });

  it('a named line whose detail is gone names the line and both refs', () => {
    expect(names((t) => delete t.Line[0].AccountBasedExpenseLineDetail)).toEqual(['Line:1', 'Line:1.AccountRef', 'Line:1.ClassRef']);
  });

  it('each named line is checked, and names are sorted by code unit', () => {
    const changes: Change[] = [{ line_id: '2', account_id: '91' }, { line_id: '1', account_id: '91', class_id: '12' }];
    expect(
      names((t) => {
        t.aField = 1;
        t.ZField = 1;
        t.TxnDate = '2026-11-11';
        t.PaymentType = 'Cash';
        t.Line[1].Amount = 1;
      }, FETCHED, changes),
    ).toEqual(['Line:1.AccountRef', 'Line:2', 'Line:2.AccountRef', 'PaymentType', 'TxnDate', 'ZField', 'aField']);
  });

  it('TA3: a stored top-level field named as a line key is named, on one side or both', () => {
    expect(names((t) => (t['Line:2'] = 'x'))).toEqual(['Line:2']);
    const fetched = { ...FETCHED, 'Line:2': 'x', 'Line:9': 'x' };
    const fields = (t: Txn) => Object.assign(t, { 'Line:2': 'x', 'Line:9': 'x' });
    expect(names(fields, fetched)).toEqual(['Line:2', 'Line:9']);
    expect(names((t) => (fields(t), (t.Line[1].Amount = 500)), fetched)).toEqual(['Line:2', 'Line:9']);
  });

  it('TA3: such a field does not stop Line being named', () => {
    expect(names((t) => (t.Line.reverse(), (t['Line:9'] = 'x')))).toEqual(['Line', 'Line:9']);
    expect(names((t) => (t.Line.reverse(), (t['Line:9'] = 'x')), { ...FETCHED, 'Line:9': 'x' })).toEqual(['Line', 'Line:9']);
  });

  it('TA3: such a field on the fetched side only does not stand in for its line', () => {
    const line = { ...copy(SENT.Line[1]), Amount: 500 };
    expect(names((t) => (t.Line[1] = line), { ...FETCHED, 'Line:2': line })).toEqual(['Line:2']);
  });

  it.each([{}, 'x', null, 0, undefined])('TA3, TA5: a stored Line that is no array names Line, unless a line is named as missing: %j', (Line) => {
    const empty = { ...FETCHED, Line: [] };
    const set = (t: Txn) => (t.Line = Line);
    expect(names(set, empty, [])).toEqual(['Line']);
    expect(names(set, empty, CHANGES)).toEqual(['Line:1']);
    expect(names(set)).toEqual(['Line:1', 'Line:2']);
    expect(names(set, FETCHED, [])).toEqual(['Line:1', 'Line:2']);
    expect(digests({ Line }, [])).toEqual({ Line: sha256Hex('[]') });
  });

  it('a transaction with no lines is the same as itself', () => {
    const empty = { ...FETCHED, Line: [] };
    expect(names(() => {}, empty, [], empty)).toEqual([]);
  });

  const line = (Id: unknown, Amount: number, account = '84') => ({ Id, Amount, AccountBasedExpenseLineDetail: { AccountRef: { value: account } } });
  it.each<[string, unknown[], unknown[]]>([
    ['no Id', [{ Amount: 5 }], [{ Amount: 500 }]],
    ['a numeric Id', [line(3, 5)], [line(3, 500, '91')]],
    ['a null Id', [line(null, 5)], [line(null, 500)]],
    ['a repeated unnamed id', [line('3', 5), line('3', 6)], [line('3', 500), line('3', 6)]],
    ['a repeated named id', [{ ...SENT.Line[0], Amount: 5 }, SENT.Line[0]], [{ ...SENT.Line[0], Amount: 500 }, SENT.Line[0]]],
    ['a line that is no object', ['x'], ['y']],
    ['a line that is an array', [['x']], [['y']]],
  ])('TA1: a stored line no digest tells apart names Line, whatever the fetched side holds: %s', (_name, was, is) => {
    const fetched = { ...FETCHED, Line: [...FETCHED.Line, ...was] };
    expect(names((t) => t.Line.push(...is), fetched)).toEqual(['Line']);
    // Even unchanged, and beside a line on one side only, which by itself would account for the order.
    expect(names((t) => t.Line.push(...was), fetched)).toEqual(['Line']);
    expect(names((t) => t.Line.push(...is, { Id: '7', Amount: 1 }), fetched)).toEqual(['Line', 'Line:7']);
  });

  it.each([null, undefined, 'x', 5, [FETCHED]])('TA4: a stored copy that is no plain object has nothing, so all the fetched side has is named: %j', (stored) => {
    expect(both(stored as unknown as Txn, FETCHED, CHANGES)).toEqual({ same: false, fields: ['Id', 'Line:1', 'Line:2', 'PaymentType', 'TotalAmt', 'TxnDate'] });
    expect(both(stored as unknown as Txn, {}, [])).toEqual({ same: false, fields: ['Line'] });
  });

  it('a named line whose detail became an array is named', () => {
    expect(names((t) => (t.Line[0].AccountBasedExpenseLineDetail = []))).toEqual(['Line:1', 'Line:1.AccountRef', 'Line:1.ClassRef']);
  });

  it('own keys named as Object.prototype members are named on either side', () => {
    const withProto = (txn: Txn, v: unknown): Txn => JSON.parse(JSON.stringify(txn).replace('{', `{"__proto__":${JSON.stringify(v)},`));
    expect(both(withProto(SENT, { a: 1 }), FETCHED, CHANGES)).toEqual({ same: false, fields: ['__proto__'] });
    expect(both(SENT, withProto(FETCHED, { a: 1 }), CHANGES)).toEqual({ same: false, fields: ['__proto__'] });
    expect(both(withProto(SENT, { a: 1 }), withProto(FETCHED, { a: 2 }), CHANGES)).toEqual({ same: false, fields: ['__proto__'] });
    expect(both(withProto(SENT, { a: 1 }), withProto(FETCHED, { a: 1 }), CHANGES)).toEqual({ same: true });
    expect(names((t) => Object.assign(t, { constructor: 'x' }))).toEqual(['constructor']);
  });

  it('intent digests are read for their own keys only: inherited ones are none, so every field is named (TM2)', () => {
    const kept = digests(FETCHED, ['1']);
    const inherited = Object.create(kept) as Record<string, string>;
    expect(compareDigests(SENT, inherited, resolveChanges(FETCHED, CHANGES))).toEqual({ same: false, fields: Object.keys(kept).filter((k) => k !== 'Line').sort() });
    expect(compareDigests(SENT, { ...kept }, resolveChanges(FETCHED, CHANGES))).toEqual({ same: true });
  });

  it('intent digests without Line fail closed', () => {
    const { Line: _line, ...kept } = digests(FETCHED, ['1']);
    expect(compareDigests(SENT, kept, resolveChanges(FETCHED, CHANGES))).toEqual({ same: false, fields: ['Line'] });
  });
});
