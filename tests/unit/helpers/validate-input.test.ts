// Sanctuary Computer (quickbooks-mcp-286): the input normalizer's unit tables (spec A5.2, A5.13's refusals, A6.3, A6.4;
// D6's sentences, D9's count rules). Every refused case has an accepted twin at its boundary; the request half, each
// handler inside a call with the QuickBooks fake, is tests/unit/handlers/search-requests.test.ts.
import { describe, it, expect } from '@jest/globals';
import {
  countToolCriteria,
  hasControl,
  normalizeBuiltSearch,
  normalizeReport,
  normalizeSearch,
  refusal,
  reportRefusalText,
  searchRefusalText,
  type ReportTool,
} from '../../../src/helpers/validate-input.js';
import { currentCall, runInCall } from '../../../src/clients/call-context.js';

const SENTENCE = (what: string) => `The search was refused before reaching QuickBooks: ${what}. Use limit up to 1000 and page with offset.`;
const REPORT = (option: string) => `The report was refused before reaching QuickBooks: ${option} isn't a valid value.`;
const refusedWith = (what: string) => ({ ok: false, failure: { reason: 'fork-error', text: SENTENCE(what) } });

/** The refusal's `<what>`, or 'ok'. */
function what(tool: string, criteria: unknown, top: Record<string, unknown> = {}): string {
  const r = normalizeSearch(tool, criteria, top);
  if (r.ok) return 'ok';
  const text = r.failure.text as string;
  expect(r.failure.reason).toBe('fork-error');
  expect(text.startsWith('The search was refused before reaching QuickBooks: ')).toBe(true);
  expect(text.endsWith('. Use limit up to 1000 and page with offset.')).toBe(true);
  return text.slice('The search was refused before reaching QuickBooks: '.length, -'. Use limit up to 1000 and page with offset.'.length);
}

const BAD_NAME = "a field name isn't valid";
const BAD_VALUE = (f: string) => `the value for ${f} isn't valid`;
const SEP = (f: string) => `the value for ${f} holds a space other than a plain space`;
const FROM = (f: string) => `the value for ${f} holds the word from`;
const LIMIT = 'limit must be a whole number from 1 to 1000';
const OFFSET = 'offset must be a whole number of at least 1';
const FETCH_ALL = "fetchAll isn't supported";
const COUNT_NO = "count isn't supported by this tool";
const COUNT_ONLY = 'count is supported only as count: true with no other criterion and no page key';

describe('D6 sentences', () => {
  it('are the spec D6 texts', () => {
    expect(searchRefusalText('x')).toBe(SENTENCE('x'));
    expect(reportRefusalText('vendor')).toBe(REPORT('vendor'));
  });
});

describe('refusal', () => {
  it('records the failure on the call and answers the error path', async () => {
    const f = { reason: 'fork-error', text: SENTENCE('x') };
    await runInCall('garden3d', async () => {
      expect(refusal(f)).toEqual({ result: null, isError: true, error: SENTENCE('x') });
      expect(currentCall()!.failure).toEqual(f);
    });
  });

  it('is a no-op on the store outside a call, and still answers the error path', () => {
    expect(refusal({ reason: 'fork-error', text: 'y' })).toEqual({ result: null, isError: true, error: 'y' });
  });
});

describe('A6.3 names: ^[A-Za-z][A-Za-z0-9.]{0,63}$ for a field, an object key, asc and desc', () => {
  const name64 = 'A' + 'a'.repeat(63);
  const name65 = 'A' + 'a'.repeat(64);
  const cases: Array<[string, string]> = [
    ['Name;', BAD_NAME],
    ['1Id', BAD_NAME],
    [name65, BAD_NAME],
    ['', BAD_NAME],
    ['.Name', BAD_NAME],
    ['Na_me', BAD_NAME],
    ['Na-me', BAD_NAME],
    ['from', BAD_NAME],
    ['a.from', BAD_NAME],
    [name64, 'ok'],
    ['A', 'ok'],
    ['z', 'ok'],
    ['Z9', 'ok'],
    ['MetaData.CreateTime', 'ok'],
    ['fromage', 'ok'],
  ];
  it.each(cases)('field %j -> %s', (name, expected) => {
    expect(what('search_purchases', [{ field: name, value: 'x' }])).toBe(expected);
    expect(what('search_accounts', { [name]: 'x' })).toBe(expected);
    expect(what('search_accounts', [{ [name]: 'x' }])).toBe(expected);
  });
  it.each(cases)('asc and desc %j', (name, expected) => {
    const sort = (k: string) => (expected === 'ok' ? 'ok' : `${k} must name a field`);
    expect(what('search_purchases', [{ field: 'asc', value: name }])).toBe(sort('asc'));
    expect(what('search_accounts', { desc: name })).toBe(sort('desc'));
  });
  it('a {field} that is not a string is refused', () => {
    expect(what('search_purchases', [{ field: undefined, value: 'x' }])).toBe(BAD_NAME);
    expect(what('search_purchases', [{ field: 5, value: 'x' }])).toBe(BAD_NAME);
    expect(what('search_purchases', [{ field: 'asc', value: 5 }])).toBe('asc must name a field');
  });
});

describe("A6.3 operators: node-quickbooks' QUERY_OPERATORS", () => {
  it.each(['=', 'IN', '<', '>', '<=', '>=', 'LIKE'])('%s is accepted', (op) => {
    expect(what('search_purchases', [{ field: 'Name', value: 'x', operator: op }])).toBe('ok');
  });
  it.each(['like', '!=', '<>', ' =', 'in', '', null, 1])('%j is refused', (op) => {
    expect(what('search_purchases', [{ field: 'Name', value: 'x', operator: op }])).toBe("the operator isn't one of = IN < > <= >= LIKE");
  });
  it('an absent operator is accepted and stays absent', () => {
    const r = normalizeSearch('search_purchases', [{ field: 'Name', value: 'x', operator: undefined }]);
    expect(r).toMatchObject({ ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 1000 }] });
    expect(Object.keys((r as any).criteria[0])).toEqual(['field', 'value']);
  });
});

describe('A6.3 values: a number, a boolean, a date, a string of at most 200 with no \\ and no control character, or an array of these', () => {
  const s200 = 'a'.repeat(200);
  const s201 = 'a'.repeat(201);
  const cases: Array<[string, unknown, string]> = [
    ['an integer', 5, 'ok'],
    ['a decimal', 1.5, 'ok'],
    ['a negative', -3, 'ok'],
    ['true', true, 'ok'],
    ['false', false, 'ok'],
    ['a date', '2026-10-01', 'ok'],
    ['200 characters', s200, 'ok'],
    ['201 characters', s201, BAD_VALUE('Name')],
    ['an empty string', '', 'ok'],
    ['abc\\', 'abc\\', BAD_VALUE('Name')],
    ['a\\b', 'a\\b', BAD_VALUE('Name')],
    ['a\\nb (LF)', 'a\nb', BAD_VALUE('Name')],
    ['U+0000', 'a\u0000', BAD_VALUE('Name')],
    ['U+001F', 'a\u001f', BAD_VALUE('Name')],
    ['U+0020 inner (a b)', 'a b', 'ok'],
    ['U+007E', 'a~', 'ok'],
    ['U+007F', 'a\u007f', BAD_VALUE('Name')],
    ['U+0080', 'a\u0080', BAD_VALUE('Name')],
    ['U+009F', 'a\u009f', BAD_VALUE('Name')],
    ['U+00A1', 'a¡', 'ok'],
    ['a quote', "O'Brien", 'ok'],
    ['an object', { a: 1 }, BAD_VALUE('Name')],
    ['null', null, BAD_VALUE('Name')],
    ['undefined in an entry', undefined, BAD_VALUE('Name')],
    ['NaN', NaN, BAD_VALUE('Name')],
    ['Infinity', Infinity, BAD_VALUE('Name')],
    ['a nested array', [['a']], BAD_VALUE('Name')],
    ['an array of these', [1, 'a', true, '2026-10-01'], 'ok'],
    ['an empty array', [], 'ok'],
    ['an array holding an object', ['a', { b: 1 }], BAD_VALUE('Name')],
    ['an array holding abc\\', ['ok', 'abc\\'], BAD_VALUE('Name')],
    ['an array holding a no-break space', ['a b'], SEP('Name')],
    ['an array holding from', ['x from y'], FROM('Name')],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    expect(what('search_purchases', [{ field: 'Name', value }])).toBe(expected);
  });
  it.each(cases.filter(([label]) => label !== 'undefined in an entry'))('%s as an object key and a record in an array', (_label, value, expected) => {
    expect(what('search_accounts', { Name: value })).toBe(expected);
    expect(what('search_accounts', [{ Name: value }])).toBe(expected);
  });
  it('an undefined object key is absent, as node-quickbooks drops it', () => {
    expect(normalizeSearch('search_accounts', { Name: undefined, Active: true })).toEqual({
      ok: true, criteria: { Active: true, limit: 1000 }, usedOffset: 1, count: false, criteriaOffset: true,
    });
  });
});

describe('hasControl: U+0000-U+001F and U+007F-U+009F, each bound and its neighbour (286 T10 step 7)', () => {
  it.each([
    ['0000', true], ['001F', true], ['0020', false], ['007E', false], ['007F', true], ['009F', true], ['00A0', false], ['00A1', false],
  ])('U+%s', (unit, expected) => {
    expect(hasControl(`a${String.fromCharCode(parseInt(unit, 16))}b`)).toBe(expected);
  });
  it('no control character in an empty or a plain string', () => {
    expect([hasControl(''), hasControl('abc')]).toEqual([false, false]);
  });
});

describe("A6.3 from as a word, and Unicode spaces other than U+0020 (contract §6's query rule)", () => {
  const cases: Array<[string, string]> = [
    ['x from y', FROM('Name')],
    ['FROM', FROM('Name')],
    ['From', FROM('Name')],
    ['(from)', FROM('Name')],
    ['x-from', FROM('Name')],
    ['from.', FROM('Name')],
    ['fromage', 'ok'],
    ['afrom', 'ok'],
    ['Zfrom', 'ok'],
    ['1from', 'ok'],
    ['_from', 'ok'],
    ['from_', 'ok'],
    ['fromA', 'ok'],
    ['from9', 'ok'],
    ['fro m', 'ok'],
    ['a b', 'ok'],
    ['a b', SEP('Name')],
    ['a　b', SEP('Name')],
    ['a b', SEP('Name')],
    ['a b', SEP('Name')],
    ['a\u2028b', SEP('Name')],
    ['a\u2029b', SEP('Name')],
    ['a\u0085b', SEP('Name')],
  ];
  it.each(cases)('%j', (value, expected) => {
    expect(what('search_purchases', [{ field: 'Name', value }])).toBe(expected);
    expect(what('search_accounts', { Name: value })).toBe(expected);
  });
});

describe('A5.2 and A6.3 limit: an integer 1..1000, in every shape and any case', () => {
  const shapes: Array<[string, string, (v: unknown) => unknown, Record<string, unknown>?]> = [
    ['an object key', 'search_accounts', (v) => ({ limit: v })],
    ['an object key, any case', 'search_accounts', (v) => ({ LIMIT: v })],
    ['a {field} entry', 'search_purchases', (v) => [{ field: 'limit', value: v }]],
    ['a {field} entry, any case', 'search_purchases', (v) => [{ field: 'Limit', value: v }]],
    ['a plain record in an array', 'search_accounts', (v) => [{ limit: v }]],
    ['a plain record in an array, any case', 'search_accounts', (v) => [{ lImIt: v }]],
    ['top level', 'search_classes', () => ({}), {}],
  ];
  const values: Array<[unknown, string]> = [
    [0, LIMIT], [1001, LIMIT], [1.5, LIMIT], ['10 x', LIMIT], ['10', LIMIT], [null, LIMIT], [-1, LIMIT], [true, LIMIT],
    [1, 'ok'], [1000, 'ok'], [999, 'ok'],
  ];
  for (const [label, tool, shape, top] of shapes) {
    it.each(values)(`${label}: %j`, (v, expected) => {
      if (top) expect(what(tool, shape(v), { limit: v })).toBe(expected);
      else expect(what(tool, shape(v))).toBe(expected);
    });
  }
  it('a missing or null criteria becomes limit 1000; so does every shape without one', () => {
    for (const c of [undefined, null]) {
      expect(normalizeSearch('search_accounts', c)).toEqual({ ok: true, criteria: { limit: 1000 }, usedOffset: 1, count: false, criteriaOffset: true });
    }
    expect(normalizeSearch('search_classes', {})).toEqual({ ok: true, criteria: { limit: 1000 }, usedOffset: 1, count: false, criteriaOffset: false });
    expect(normalizeSearch('search_deposits', [])).toEqual({ ok: true, criteria: [{ field: 'limit', value: 1000 }], usedOffset: 1, count: false, criteriaOffset: false });
  });
  it('a given limit is passed under its exact name, in the shape it came in', () => {
    expect(normalizeSearch('search_accounts', { Name: 'x', LIMIT: 5 })).toMatchObject({ criteria: { Name: 'x', limit: 5 } });
    expect(normalizeSearch('search_purchases', [{ field: 'Limit', value: 5 }, { field: 'Name', value: 'x' }])).toMatchObject({
      criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 5 }],
    });
    expect(normalizeSearch('search_accounts', [{ Limit: 5, Name: 'x' }])).toMatchObject({ criteria: [{ Name: 'x' }, { field: 'limit', value: 5 }] });
    expect(normalizeSearch('search_classes', { Name: 'x' }, { limit: 7 })).toMatchObject({ criteria: { Name: 'x', limit: 7 } });
  });
});

describe('A5.13 and A6.3 offset: an integer >= 1; usedOffset is the startposition the request carries', () => {
  const shapes: Array<[string, string, (v: unknown) => unknown, boolean?]> = [
    ['an object key', 'search_invoices', (v) => ({ offset: v })],
    ['an object key, any case', 'search_invoices', (v) => ({ Offset: v })],
    ['a {field} entry', 'search_purchases', (v) => [{ field: 'offset', value: v }]],
    ['a {field} entry, any case', 'search_employees', (v) => [{ field: 'OFFSET', value: v }]],
    ['a plain record in an array', 'search_items', (v) => [{ offset: v }]],
    ['top level', 'search_transfers', () => [], true],
  ];
  const values: Array<[unknown, string]> = [[0, OFFSET], [1.5, OFFSET], ['2', OFFSET], [-1, OFFSET], [null, OFFSET], [1, 'ok'], [101, 'ok'], [1000001, 'ok']];
  for (const [label, tool, shape, top] of shapes) {
    it.each(values)(`${label}: %j`, (v, expected) => {
      const r = top ? normalizeSearch(tool, shape(v), { offset: v }) : normalizeSearch(tool, shape(v));
      if (expected === 'ok') expect(r).toMatchObject({ ok: true, usedOffset: v });
      else expect(r).toEqual(refusedWith(expected));
    });
  }
  it('no offset is usedOffset 1, and no offset is added', () => {
    expect(normalizeSearch('search_purchases', [{ field: 'Name', value: 'x' }])).toEqual({
      ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 1000 }], usedOffset: 1, count: false, criteriaOffset: false,
    });
  });
  it('a given offset is passed under its exact name, after limit', () => {
    expect(normalizeSearch('search_invoices', { OFFSET: 101 })).toEqual({ ok: true, criteria: { limit: 1000, offset: 101 }, usedOffset: 101, count: false, criteriaOffset: true });
    expect(normalizeSearch('search_purchases', [{ field: 'Offset', value: 101 }, { field: 'Limit', value: 21 }])).toMatchObject({
      criteria: [{ field: 'limit', value: 21 }, { field: 'offset', value: 101 }],
      usedOffset: 101,
    });
    expect(normalizeSearch('search_classes', {}, { offset: 3 })).toMatchObject({ criteria: { limit: 1000, offset: 3 }, usedOffset: 3 });
  });
  it.each([
    ['search_accounts', true], ['search_invoices', true], ['search_items', true],
    ['search_purchases', false], ['search_bills', false], ['search_classes', false], ['search_vendor_credits', false],
  ])('criteriaOffset for %s is %s (the three take offset inside criteria)', (tool, inside) => {
    expect(normalizeSearch(tool, {})).toMatchObject({ ok: true, criteriaOffset: inside });
  });
  it('asc and desc pass under their exact names', () => {
    expect(normalizeSearch('search_accounts', { ASC: 'Name', Desc: 'Id' })).toMatchObject({ criteria: { asc: 'Name', desc: 'Id', limit: 1000 } });
  });
});

describe('A5.2 a page key given twice is refused', () => {
  const cases: Array<[string, string, string, unknown, Record<string, unknown>]> = [
    ['limit twice in an array', 'limit', 'search_purchases', [{ field: 'limit', value: 5 }, { field: 'limit', value: 5 }], {}],
    ['limit and Limit in an object', 'limit', 'search_accounts', { limit: 5, Limit: 5 }, {}],
    ['limit in two records', 'limit', 'search_accounts', [{ limit: 5 }, { LIMIT: 6 }], {}],
    ['top-level limit and a criteria limit', 'limit', 'search_classes', { limit: 5 }, { limit: 5 }],
    ['offset twice', 'offset', 'search_purchases', [{ field: 'offset', value: 2 }, { field: 'Offset', value: 3 }], {}],
    ['top-level offset and a criteria offset', 'offset', 'search_classes', [{ field: 'offset', value: 2 }], { offset: 2 }],
    ['asc twice', 'asc', 'search_accounts', { asc: 'Name', ASC: 'Id' }, {}],
    ['desc twice', 'desc', 'search_purchases', [{ field: 'desc', value: 'Name' }, { desc: 'Name' }], {}],
  ];
  it.each(cases)('%s', (_label, key, tool, criteria, top) => {
    expect(what(tool, criteria, top)).toBe(`${key} is given more than once`);
  });
  it('each once is accepted', () => {
    expect(what('search_purchases', [{ field: 'limit', value: 5 }, { field: 'offset', value: 2 }, { field: 'asc', value: 'Name' }, { field: 'desc', value: 'Id' }])).toBe('ok');
  });
});

describe('A5.2 and A5.3 fetchAll is refused in any shape, case and value (D8)', () => {
  const cases: Array<[string, string, unknown]> = [
    ['an object key', 'search_accounts', { fetchAll: true }],
    ['an object key, false', 'search_accounts', { fetchAll: false }],
    ['an object key, lower case', 'search_invoices', { fetchall: true }],
    ['an object key, upper case', 'search_items', { FETCHALL: true }],
    ['a {field} entry', 'search_purchases', [{ field: 'fetchAll', value: true }]],
    ['a {field} entry, false', 'search_journal_entries', [{ field: 'fetchAll', value: false }]],
    ['a {field} entry, any case', 'search_bill_payments', [{ field: 'FetchAll', value: true }]],
    ['a plain record in an array', 'search_accounts', [{ fetchAll: true }]],
    ['a record beside a filter', 'search_bills', { DocNumber: '1', fetchAll: true }],
  ];
  it.each(cases)('%s', (_label, tool, criteria) => {
    expect(what(tool, criteria)).toBe(FETCH_ALL);
  });
});

describe('D9 count: only a lone count: true on search_bills, search_customers and search_vendors', () => {
  it.each(['search_bills', 'search_customers', 'search_vendors'])('%s accepts top-level count and a folded {key} entry in any case', (tool) => {
    const ok = { ok: true, criteria: { count: true }, usedOffset: 1, count: true, criteriaOffset: false };
    expect(normalizeSearch(tool, { count: true })).toEqual(ok);
    expect(normalizeSearch(tool, { Count: true })).toEqual(ok);
    expect(normalizeSearch(tool, { COUNT: true })).toEqual(ok);
    expect(normalizeSearch(tool, {}, { count: true })).toEqual(ok);
  });
  const refusedThree: Array<[string, unknown, Record<string, unknown>]> = [
    ['count: false', { count: false }, {}],
    ['Count: false', { Count: false }, {}],
    ['count: "true"', { count: 'true' }, {}],
    ['count: 1', { count: 1 }, {}],
    ['top-level count: false', {}, { count: false }],
    ['count beside a {key} criterion', { count: true, DisplayName: 'x' }, {}],
    ['count beside a {field} criterion', [{ field: 'DisplayName', value: 'x' }, { field: 'count', value: true }], {}],
    ['count beside limit: 10', { count: true, limit: 10 }, {}],
    ['count beside offset', { count: true, offset: 2 }, {}],
    ['count beside asc', { count: true, asc: 'Id' }, {}],
    ['count beside desc', { count: true, desc: 'Id' }, {}],
    ['count beside a top-level limit', { count: true }, { limit: 10 }],
    ['top-level count beside a {field} entry', [{ field: 'DocNumber', value: '1' }], { count: true }],
    ['a lone {field: count} entry', [{ field: 'count', value: true }], {}],
    ['a lone {field: Count} entry', [{ field: 'Count', value: true }], {}],
    ['count twice', { count: true, Count: true }, {}],
    ['count in a record in an array', [{ count: true }], {}],
  ];
  it.each(refusedThree)('the three refuse %s', (_label, criteria, top) => {
    for (const tool of ['search_bills', 'search_customers', 'search_vendors']) expect(what(tool, criteria, top)).toBe(COUNT_ONLY);
  });
  const seven = ['search_accounts', 'search_invoices', 'search_items', 'search_bill_payments', 'search_employees', 'search_journal_entries', 'search_purchases'];
  const shapes: Array<[string, unknown]> = [
    ['count: true', { count: true }],
    ['Count: true', { Count: true }],
    ['COUNT: true', { COUNT: true }],
    ['a {field: count} entry', [{ field: 'count', value: true }]],
    ['a {field: Count} entry', [{ field: 'Count', value: true }]],
    ['a record in an array', [{ count: true }]],
    ['count: false', { count: false }],
  ];
  it.each(shapes)('the seven refuse %s', (_label, criteria) => {
    for (const tool of seven) expect(what(tool, criteria)).toBe(COUNT_NO);
  });
  it('the 8 fixed-schema tools refuse a top-level count reaching them', () => {
    expect(what('search_classes', {}, { count: true })).toBe(COUNT_NO);
  });
});

describe('A5.2 shapes: a criteria string, a function or any other non-object is refused', () => {
  const NOT_OBJECT = 'criteria must be an object or an array';
  it.each([
    ['a string', "Name = 'x'"],
    ['an empty string', ''],
    ['a function', () => 1],
    ['a number', 5],
    ['a boolean', true],
  ])('%s', (_label, criteria) => {
    expect(what('search_accounts', criteria)).toBe(NOT_OBJECT);
  });
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a nested array', [[{ field: 'Name', value: 'x' }]]],
    ['a number', 5],
  ])('an array element that is %s', (_label, el) => {
    expect(what('search_accounts', [el])).toBe('each criterion must be an object');
  });
  it('a {field, value} entry with any other key is refused (node-quickbooks would read a count key there)', () => {
    expect(what('search_purchases', [{ field: 'Name', value: 'x', count: true }])).toBe('a criterion has a key other than field, value and operator');
    expect(what('search_purchases', [{ field: 'Name', value: 'x', key: 'y' }])).toBe('a criterion has a key other than field, value and operator');
    expect(what('search_purchases', [{ field: 'Name', value: 'x', operator: '=' }])).toBe('ok');
  });
  it('a {field} without a value is a plain record, as toCriterion reads one: both keys make an entry', () => {
    expect(normalizeSearch('search_accounts', [{ field: 'Name' }])).toMatchObject({ ok: true, criteria: [{ field: 'Name' }, { field: 'limit', value: 1000 }] });
    expect(what('search_accounts', [{ field: 'Name', value: undefined }])).toBe(BAD_VALUE('Name'));
  });
  it('a record with only page keys leaves no empty record behind', () => {
    expect(normalizeSearch('search_accounts', [{ limit: 5 }, { Name: 'x' }])).toMatchObject({ criteria: [{ Name: 'x' }, { field: 'limit', value: 5 }] });
  });
  it('an error that is not a refusal is thrown, not answered as one', () => {
    const hostile = Object.defineProperty({}, 'Name', { enumerable: true, get: () => { throw new TypeError('boom'); } });
    expect(() => normalizeSearch('search_accounts', hostile)).toThrow('boom');
  });
});

describe('A6.4 report options: each key per report, refused with D6 and accepted at the boundary', () => {
  const DATE_BAD = ['2026-10-01&x=1', '2026-1-01', '26-10-01', '2026-10-1', '2026-10-01 ', 'x2026-10-01', '', 20261001];
  const DATE_OK = ['2026-10-01', '0000-00-00'];
  const ID_BAD = ['5#', '1,', ',1', '1,,2', 'a b', '1 ', '-1', '123456789012345678901', '1,123456789012345678901', '', 5];
  const ID_OK = ['1', '0', '1,2', '12345678901234567890', '1,12345678901234567890,3'];
  const PERIOD_BAD = [0, 1000, 1.5, -1, '30', null];
  const PERIOD_OK = [1, 999, 30];
  const SORT_BAD = ['a b', 'a'.repeat(65), '', 'a1', 'a-b', 'a.b', 5];
  const SORT_OK = ['Date', 'a'.repeat(64), '_', 'tx_date', 'Z'];
  const TOOLS: Record<ReportTool, Record<string, 'date' | 'id' | 'period' | 'sort' | string[]>> = {
    get_aged_payables: { report_date: 'date', vendor: 'id', aging_method: ['Current', 'Report_Date'], days_per_aging_period: 'period', num_periods: 'period' },
    get_aged_receivables: { report_date: 'date', customer: 'id', aging_method: ['Current', 'Report_Date'], days_per_aging_period: 'period', num_periods: 'period' },
    get_balance_sheet: { start_date: 'date', end_date: 'date', accounting_method: ['Cash', 'Accrual'], summarize_column_by: ['Total', 'Month', 'Week', 'Days'] },
    get_cash_flow: { start_date: 'date', end_date: 'date', summarize_column_by: ['Total', 'Month', 'Week', 'Days'] },
    get_customer_balance: { report_date: 'date', customer: 'id', summarize_column_by: ['Total', 'Month', 'Week', 'Days'] },
    get_customer_sales: { start_date: 'date', end_date: 'date', customer: 'id', summarize_column_by: ['Total', 'Month', 'Week', 'Days'] },
    get_general_ledger: { start_date: 'date', end_date: 'date', accounting_method: ['Cash', 'Accrual'], account: 'id', source_account: 'id', sort_by: 'sort' },
    get_profit_and_loss: {
      start_date: 'date', end_date: 'date', accounting_method: ['Cash', 'Accrual'], summarize_column_by: ['Total', 'Month', 'Week', 'Days', 'Classes'],
      customer: 'id', vendor: 'id', item: 'id', department: 'id', class: 'id',
    },
    get_trial_balance: { start_date: 'date', end_date: 'date', accounting_method: ['Cash', 'Accrual'] },
    get_vendor_balance: { report_date: 'date', vendor: 'id', summarize_column_by: ['Total', 'Month', 'Week', 'Days'] },
    get_vendor_expenses: { start_date: 'date', end_date: 'date', vendor: 'id', summarize_column_by: ['Total', 'Month', 'Week', 'Days'], accounting_method: ['Cash', 'Accrual'] },
  };
  const valuesOf = (kind: 'date' | 'id' | 'period' | 'sort' | string[]): { bad: unknown[]; ok: unknown[] } => {
    if (Array.isArray(kind)) return { bad: ['Bogus', kind[0].toLowerCase(), kind[0] + ' ', 'Classes&x=1', 5], ok: kind };
    return { date: { bad: DATE_BAD, ok: DATE_OK }, id: { bad: ID_BAD, ok: ID_OK }, period: { bad: PERIOD_BAD, ok: PERIOD_OK }, sort: { bad: SORT_BAD, ok: SORT_OK } }[kind];
  };
  const rows: Array<[ReportTool, string, 'date' | 'id' | 'period' | 'sort' | string[]]> = [];
  for (const [tool, keys] of Object.entries(TOOLS) as Array<[ReportTool, (typeof TOOLS)[ReportTool]]>) {
    for (const [key, kind] of Object.entries(keys)) rows.push([tool, key, kind]);
  }
  it.each(rows)('%s %s', (tool, key, kind) => {
    const { bad, ok } = valuesOf(kind);
    for (const v of bad) {
      expect([v, normalizeReport(tool, { [key]: v })]).toEqual([v, { ok: false, failure: { reason: 'fork-error', text: REPORT(key) } }]);
    }
    for (const v of ok) {
      const options = { [key]: v };
      expect([v, normalizeReport(tool, options)]).toEqual([v, { ok: true, options }]);
    }
  });
  it("Classes is in get_profit_and_loss's summarize_column_by enum only", () => {
    expect(normalizeReport('get_profit_and_loss', { summarize_column_by: 'Classes' })).toMatchObject({ ok: true });
    expect(normalizeReport('get_balance_sheet', { summarize_column_by: 'Classes' })).toMatchObject({ ok: false });
  });
  it('T8-6: only the checked keys are passed on; a key with no rule for the report never is', () => {
    const r = normalizeReport('get_trial_balance', { vendor: '5#', start_date: '2026-10-01', extra: 'x&y=1' }) as { ok: true; options: object };
    expect(r).toEqual({ ok: true, options: { start_date: '2026-10-01' } });
    expect(Object.keys(r.options)).toEqual(['start_date']);
  });
  it('an undefined key is absent; missing options are {}; non-object options are refused', () => {
    const undef = normalizeReport('get_cash_flow', { start_date: undefined }) as { ok: true; options: object };
    expect(Object.keys(undef.options)).toEqual([]);
    expect(normalizeReport('get_cash_flow', undefined)).toEqual({ ok: true, options: {} });
    expect(normalizeReport('get_cash_flow', null)).toEqual({ ok: true, options: {} });
    for (const o of ['start_date=2026-10-01', [], 5]) {
      expect(normalizeReport('get_cash_flow', o)).toEqual({ ok: false, failure: { reason: 'fork-error', text: REPORT('options') } });
    }
  });
  it('the first refused key in the report’s own order is named', () => {
    expect(normalizeReport('get_profit_and_loss', { vendor: 'x', customer: 'y' })).toMatchObject({ failure: { text: REPORT('customer') } });
  });
});

// Fix round 1 (T8-1, T8-3): the seven builder handlers' input, checked before and after buildQuickbooksSearchCriteria.
describe('T8-3 normalizeBuiltSearch checks every value the builder dereferences before it runs', () => {
  const built = (input: unknown) => whatBuilt('search_accounts', input);
  it.each([
    ['filters a string', { filters: 'abc' }, 'filters must be an array'],
    ['filters an object', { filters: { field: 'Name', value: 'x' } }, 'filters must be an array'],
    ['filters a number', { filters: 5 }, 'filters must be an array'],
    ['criteria a string', { criteria: 'abc' }, 'criteria must be an array'],
    ['criteria true', { criteria: true }, 'criteria must be an array'],
    ['filters holding null', { filters: [null] }, 'each criterion must be an object'],
    ['criteria holding null', { criteria: [null] }, 'each criterion must be an object'],
    ['criteria holding a string', { criteria: [{ field: 'Name', value: 'x' }, 'x'] }, 'each criterion must be an object'],
    ['filters holding an array', { filters: [[{ field: 'Name', value: 'x' }]] }, 'each criterion must be an object'],
    ['filters and criteria both (the builder would drop criteria)', { filters: [], criteria: [{ field: 'Name', value: 'x' }] }, 'give filters or criteria, not both'],
    ['filters and criteria both, non-empty', { filters: [{ field: 'Name', value: 'a' }], criteria: [{ field: 'Name', value: 'b' }] }, 'give filters or criteria, not both'],
  ] as Array<[string, unknown, string]>)('%s is refused', (_label, input, expected) => {
    expect(built(input)).toBe(expected);
  });
  it.each([
    ['filters an array of objects', { filters: [{ field: 'Name', value: 'x' }] }],
    ['criteria an array of objects', { criteria: [{ field: 'Name', value: 'x' }] }],
    ['an empty filters list', { filters: [] }],
    ['filters null beside a criteria list (the builder reads criteria)', { filters: null, criteria: [{ field: 'Name', value: 'x' }] }],
    ['criteria null beside a filters list', { filters: [{ field: 'Name', value: 'x' }], criteria: null }],
    ['filters undefined', { filters: undefined, limit: 5 }],
    ['no criteria', undefined],
    ['an array', [{ field: 'Name', value: 'x' }]],
  ] as Array<[string, unknown]>)('%s is accepted', (_label, input) => {
    expect(built(input)).toBe('ok');
  });
  it('a string or function still reaches normalizeSearch and is refused there', () => {
    expect(built("Name = 'x'")).toBe('criteria must be an object or an array');
    expect(built(() => 1)).toBe('criteria must be an object or an array');
  });
  it('a null list beside the other keeps the other list as the builder reads it', () => {
    expect(normalizeBuiltSearch('search_accounts', { filters: null, criteria: [{ field: 'Name', value: 'x' }] })).toMatchObject({
      ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 1000 }],
    });
  });
});

describe('T8-1 a filter key beside an advanced key reaches the normalizer as a filter (every shape the three accept)', () => {
  const tools = ['search_accounts', 'search_invoices', 'search_items'];
  it.each(tools)('%s: a filter beside each page key is kept and filters the query', (tool) => {
    expect(normalizeBuiltSearch(tool, { CustomerRef: '5', offset: 1001 })).toEqual({
      ok: true,
      criteria: [{ field: 'CustomerRef', value: '5' }, { field: 'offset', value: 1001 }, { field: 'limit', value: 1000 }],
      usedOffset: 1001, count: false, criteriaOffset: true,
    });
    expect(normalizeBuiltSearch(tool, { Name: 'x', limit: 5 })).toMatchObject({ ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 5 }] });
    expect(normalizeBuiltSearch(tool, { Name: 'x', asc: 'Id' })).toMatchObject({ ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'asc', value: 'Id' }, { field: 'limit', value: 1000 }] });
    expect(normalizeBuiltSearch(tool, { Name: 'x', desc: 'Id' })).toMatchObject({ ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'desc', value: 'Id' }, { field: 'limit', value: 1000 }] });
    expect(normalizeBuiltSearch(tool, { Name: 'x', filters: [{ field: 'Id', value: '1' }] })).toMatchObject({
      ok: true, criteria: [{ field: 'Id', value: '1' }, { field: 'Name', value: 'x' }, { field: 'limit', value: 1000 }],
    });
    expect(normalizeBuiltSearch(tool, { Name: 'x', Limit: 5, offset: 2 })).toMatchObject({ ok: true, criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 5 }, { field: 'offset', value: 2 }] });
    expect(normalizeBuiltSearch(tool, { Offset: 101, limit: 5 })).toMatchObject({ ok: true, usedOffset: 101, criteria: [{ field: 'limit', value: 5 }, { field: 'offset', value: 101 }] });
  });
  it.each(tools)('%s: an array value beside a page key is IN, as a plain record reads it', (tool) => {
    expect(normalizeBuiltSearch(tool, { Id: ['1', '2'], limit: 5 })).toMatchObject({ ok: true, criteria: [{ field: 'Id', value: ['1', '2'], operator: 'IN' }, { field: 'limit', value: 5 }] });
  });
  it.each(tools)('%s: a bad key beside a page key is refused, not dropped', (tool) => {
    const w = (input: unknown) => whatBuilt(tool, input);
    expect(w({ 'Name;': 'x', limit: 5 })).toBe(BAD_NAME);
    expect(w({ FetchAll: true, limit: 5 })).toBe(FETCH_ALL);
    expect(w({ Count: true, limit: 5 })).toBe(COUNT_NO);
    expect(w({ count: true, Name: 'x' })).toBe(COUNT_NO);
    expect(w({ fetchAll: true, Name: 'x' })).toBe(FETCH_ALL);
    expect(w({ Name: 'abc\\', offset: 2 })).toBe(BAD_VALUE('Name'));
    expect(w({ Limit: 5, limit: 5 })).toBe('limit is given more than once');
    expect(w({ Name: 'x', LIMIT: 5, limit: 6 })).toBe('limit is given more than once');
  });
  it('an undefined key beside a page key is absent', () => {
    expect(normalizeBuiltSearch('search_items', { Name: undefined, limit: 5 })).toMatchObject({ ok: true, criteria: [{ field: 'limit', value: 5 }] });
  });
});

/** normalizeBuiltSearch's refusal `<what>`, or 'ok'. */
function whatBuilt(tool: string, input: unknown): string {
  const r = normalizeBuiltSearch(tool, input);
  if (r.ok) return 'ok';
  return (r.failure.text as string).slice('The search was refused before reaching QuickBooks: '.length, -'. Use limit up to 1000 and page with offset.'.length);
}

// Fix round 2 (TB8-1, TB8-2): a list element's keys, and an object that is one {field, value, operator} criterion.
const EXTRA = 'a criterion has a key other than field, value and operator';

describe('TB8-1 a filters or criteria element with a key other than field, value and operator is refused before the builder', () => {
  const tools = ['search_accounts', 'search_invoices', 'search_items', 'search_bill_payments', 'search_employees', 'search_journal_entries', 'search_purchases'];
  const extras: Array<[string, unknown]> = [['fetchAll', true], ['count', true], ['Count', true], ['extra', 'y'], ['limit', 5], ['key', 'Name'], ['Operator', '=']];
  it.each(['filters', 'criteria'])('%s: each extra key, on each of the seven builder tools', (list) => {
    for (const tool of tools) {
      for (const [k, v] of extras) {
        expect([tool, k, whatBuilt(tool, { [list]: [{ field: 'Id', value: '1', [k]: v }] })]).toEqual([tool, k, EXTRA]);
        expect([tool, k, whatBuilt(tool, { [list]: [{ field: 'Id', value: '1' }, { field: 'Id', value: '2', [k]: v }] })]).toEqual([tool, k, EXTRA]);
      }
    }
  });
  it.each(['filters', 'criteria'])('%s: an element with field, value and operator, or fewer, is accepted', (list) => {
    expect(normalizeBuiltSearch('search_invoices', { [list]: [{ field: 'Id', value: '1', operator: '=' }, { field: 'Id', value: '2' }] })).toMatchObject({
      ok: true, criteria: [{ field: 'Id', value: '1', operator: '=' }, { field: 'Id', value: '2' }, { field: 'limit', value: 1000 }],
    });
    // an element with field and no value reaches the builder whole and is refused for its missing value, not lost
    expect(whatBuilt('search_invoices', { [list]: [{ field: 'Id' }] })).toBe(BAD_VALUE('Id'));
  });
  it('the same element given as a direct array gets the same refusal', () => {
    expect(what('search_invoices', [{ field: 'Id', value: '1', fetchAll: true }])).toBe(EXTRA);
    expect(whatBuilt('search_invoices', [{ field: 'Id', value: '1', fetchAll: true }])).toBe(EXTRA);
  });
});

describe('TB8-2 an object whose own keys are field and value (and operator) is one criterion, page keys beside it included', () => {
  const entry = { field: 'Name', value: 'x', operator: '=' };
  const asEntry = { field: 'Name', value: 'x', operator: '=' };
  const cases: Array<[string, Record<string, unknown>, unknown[], number]> = [
    ['no page key', {}, [asEntry, { field: 'limit', value: 1000 }], 1],
    ['limit', { limit: 5 }, [asEntry, { field: 'limit', value: 5 }], 1],
    ['Limit (any case)', { Limit: 5 }, [asEntry, { field: 'limit', value: 5 }], 1],
    ['offset', { offset: 101 }, [asEntry, { field: 'offset', value: 101 }, { field: 'limit', value: 1000 }], 101],
    ['OFFSET (any case)', { OFFSET: 101 }, [asEntry, { field: 'offset', value: 101 }, { field: 'limit', value: 1000 }], 101],
    ['asc', { asc: 'Id' }, [asEntry, { field: 'asc', value: 'Id' }, { field: 'limit', value: 1000 }], 1],
    ['desc', { desc: 'Id' }, [asEntry, { field: 'desc', value: 'Id' }, { field: 'limit', value: 1000 }], 1],
    ['limit and offset', { limit: 21, offset: 101 }, [asEntry, { field: 'limit', value: 21 }, { field: 'offset', value: 101 }], 101],
    ['an undefined key', { Other: undefined }, [asEntry, { field: 'limit', value: 1000 }], 1],
  ];
  it.each(cases)('%s, through normalizeBuiltSearch and normalizeSearch alike', (_label, page, criteria, usedOffset) => {
    const expected = { ok: true, criteria, usedOffset, count: false, criteriaOffset: true };
    expect(normalizeBuiltSearch('search_accounts', { ...entry, ...page })).toEqual(expected);
    expect(normalizeSearch('search_accounts', { ...entry, ...page })).toEqual(expected);
  });
  it('without an operator the criterion has none', () => {
    expect(normalizeBuiltSearch('search_items', { field: 'Name', value: 'x', limit: 5 })).toMatchObject({ criteria: [{ field: 'Name', value: 'x' }, { field: 'limit', value: 5 }] });
  });
  it.each([
    ['a field name that would escape the statement', { field: "Id = '1' or Id", value: 'x' }, BAD_NAME],
    ['the same beside limit', { field: "Id = '1' or Id", value: 'x', limit: 5 }, BAD_NAME],
    ['an operator outside the list', { field: 'Name', value: 'x', operator: '!=' }, "the operator isn't one of = IN < > <= >= LIKE"],
    ['a bad value', { field: 'Name', value: 'abc\\', limit: 5 }, BAD_VALUE('Name')],
    ['fetchAll beside it', { field: 'Name', value: 'x', fetchAll: true }, FETCH_ALL],
    ['count beside it', { field: 'Name', value: 'x', count: true }, COUNT_NO],
    ['another filter key beside it (toCriterion would drop it)', { field: 'Name', value: 'x', Active: true }, EXTRA],
    ['the same with a page key', { field: 'Name', value: 'x', Active: true, limit: 5 }, EXTRA],
    ['limit twice', { field: 'limit', value: 5, limit: 5 }, 'limit is given more than once'],
  ] as Array<[string, unknown, string]>)('%s is refused', (_label, input, expected) => {
    expect(whatBuilt('search_accounts', input)).toBe(expected);
    expect(what('search_accounts', input)).toBe(expected);
  });
  it('beside a filters or criteria list it would be lost, so it is refused', () => {
    expect(whatBuilt('search_accounts', { field: 'Name', value: 'x', filters: [{ field: 'Id', value: '1' }] })).toBe(EXTRA);
    expect(whatBuilt('search_purchases', { field: 'Name', value: 'x', criteria: [] })).toBe(EXTRA);
  });
  it('an object with value and no field is a plain record, its key named value a filter, as toCriterion reads it', () => {
    expect(normalizeSearch('search_accounts', { value: 'x' })).toEqual({ ok: true, criteria: { value: 'x', limit: 1000 }, usedOffset: 1, count: false, criteriaOffset: true });
    expect(normalizeBuiltSearch('search_accounts', { value: 'x', limit: 5 })).toEqual({
      ok: true, criteria: [{ field: 'value', value: 'x' }, { field: 'limit', value: 5 }], usedOffset: 1, count: false, criteriaOffset: true,
    });
  });
  it('a filters or criteria key that is null beside it is refused too', () => {
    expect(whatBuilt('search_accounts', { field: 'Name', value: 'x', filters: null })).toBe(EXTRA);
  });
  it('a lone {field: limit} criterion is a page key', () => {
    expect(normalizeSearch('search_accounts', { field: 'limit', value: 5 })).toMatchObject({ ok: true, criteria: [{ field: 'limit', value: 5 }] });
  });
  it('an object with field and no value is a plain record, as toCriterion reads it', () => {
    expect(normalizeBuiltSearch('search_accounts', { field: 'Name', limit: 5 })).toMatchObject({ ok: true, criteria: [{ field: 'field', value: 'Name' }, { field: 'limit', value: 5 }] });
    expect(normalizeSearch('search_accounts', { field: 'Name' })).toMatchObject({ ok: true, criteria: { field: 'Name', limit: 1000 } });
  });
  it('on the count tools the folded key form reads the same way', () => {
    expect(normalizeSearch('search_bills', { field: 'DocNumber', value: '9' })).toMatchObject({ ok: true, criteria: [{ field: 'DocNumber', value: '9' }, { field: 'limit', value: 1000 }] });
    expect(what('search_bills', { field: 'DocNumber', value: '9', count: true })).toBe(COUNT_ONLY);
  });
});

// T12 fix 2 (TC12-1, TC12-2): the three count tools' fold, each rule against its accepted twin.
describe('countToolCriteria', () => {
  const k = (key: string, value: unknown) => ({ key, value });
  it('an empty list is the top-level options alone', () => {
    expect(countToolCriteria([], { asc: 'Id', count: true })).toStrictEqual({ ok: true, criteria: { asc: 'Id', count: true } });
  });
  it('the {field} form goes on as a list, the top-level options as entries after it, extra keys kept for normalizeSearch', () => {
    expect(countToolCriteria([{ field: 'Id', value: '1', extra: 'x' }], { asc: 'Id' })).toStrictEqual({
      ok: true,
      criteria: [{ field: 'Id', value: '1', extra: 'x' }, { field: 'asc', value: 'Id' }],
    });
  });
  it('the {key} form is one record over the top-level options, each key once', () => {
    expect(countToolCriteria([k('DocNumber', ''), k('Id', false)], { asc: 'Id' })).toStrictEqual({ ok: true, criteria: { asc: 'Id', DocNumber: '', Id: false } });
    expect(countToolCriteria([k('DocNumber', null)], {})).toStrictEqual({ ok: true, criteria: {} });
  });
  it.each([
    ['a mixed list, {field} first', [{ field: 'Id', value: '1' }, k('Id', '2')], {}, 'give every criterion as {field, value} or every one as {key, value}, not both'],
    ['a mixed list, {key} first', [k('Id', '2'), { field: 'Id', value: '1' }], {}, 'give every criterion as {field, value} or every one as {key, value}, not both'],
    ['one element with both', [{ field: 'Id', value: '1', key: 'DocNumber' }], {}, 'give every criterion as {field, value} or every one as {key, value}, not both'],
    ['an operator on {key}', [{ key: 'Balance', value: '0', operator: '>' }], {}, 'a criterion given as {key, value} has a key other than key and value'],
    ['a key twice', [k('DocNumber', '1'), k('DocNumber', '2')], {}, 'DocNumber is given more than once'],
    ['a key twice by case', [k('Id', '1'), k('ID', '2')], {}, 'Id is given more than once'],
    ['a key in the list and at the top', [k('count', true)], { count: false }, 'count is given more than once'],
  ] as const)('%s is refused', (_what, criteria, options, what) => {
    expect(countToolCriteria([...criteria], { ...options })).toStrictEqual(refusedWith(what));
  });
});
