// Sanctuary Computer (quickbooks-mcp-286): results in contract 1.1 §5's grammar at unit level (spec A4.7's text forms,
// A5.4, A5.5, A5.5b, A5.6, A5.10, A5.11, A5.12; D6, D9). Every render and cut fixture in tests/fakes is produced exactly;
// the nothing-fits cases of A5.10 are one built case each. The through-the-server half is T12's.
import { describe, it, expect, beforeAll } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  classify,
  cut,
  cutWarning,
  errorResult,
  REASON_TEXT,
  render,
  RESULT_MAX,
  shapeResult,
  toolKind,
  searchRowSizes,
  WARNING_MAX,
} from '../../../src/helpers/tool-result.js';
import { currentCall, runInCall, setUsedOffset, type CallStore, type Failure } from '../../../src/clients/call-context.js';
import { newCallRecord } from '../../../src/clients/guard-decide.js';
import { READ_ALLOWLIST } from '../../../src/allowlist.js';
import { normalizeBuiltSearch, normalizeSearch } from '../../../src/helpers/validate-input.js';

const fakePath = (name: string) => fileURLToPath(new URL(`../../fakes/${name}`, import.meta.url));
const fake = (name: string): any => JSON.parse(readFileSync(fakePath(name), 'utf8'));

// The Result grammar's sentences (contract §5), copied.
const ROWS = (m: number, t: number, o: number, inside = false) =>
  `truncated: ${m} of ${t} rows left out. Next page: pass offset ${o}${inside ? ' inside criteria' : ''}.`;
const LINES = (l: number, L: number, m: number, t: number, o: number, inside = false) =>
  `truncated: ${l} of ${L} Lines of the first row left out, and ${m} of ${t} rows. That row's later Lines can't be read here. Next page: pass offset ${o}${inside ? ' inside criteria' : ''}.`;
const REPORT = (m: number, t: number) => `truncated: ${m} of ${t} report rows left out. Narrow the report: a shorter date range, or fewer columns.`;
const OBJECT = "truncated: the result is longer than 30,000 characters and can't be shown.";
const WARNING_CUT = 'truncated: warning cut at 2,000 characters.';

const item = (text: string) => ({ type: 'text' as const, text });
const raw = (...texts: string[]) => ({ content: texts.map(item) });
const call = (over: Partial<CallStore> = {}): CallStore => ({ company: 'garden3d', record: newCallRecord(), failure: null, warnings: [], ...over });
const length = (r: CallToolResult) => (r.content as { text: string }[]).reduce((n, c) => n + c.text.length, 0);
const dataOf = (r: CallToolResult) => (r.content[0] as { text: string }).text;
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const SEARCH_TOOLS = READ_ALLOWLIST.filter((t) => t.startsWith('search_'));
const CRITERIA_THREE = ['search_accounts', 'search_invoices', 'search_items'];

/** A search row (an entity) whose header line is exactly `n` characters, with `lines` Lines of `lineLen` each. */
function entity(id: number, n: number, lines = 0, lineLen = 40): Record<string, unknown> {
  const e: Record<string, unknown> = { Id: String(id), Memo: '' };
  const bare = JSON.stringify({ ...e, depth: 0 }).length;
  e.Memo = 'm'.repeat(n - bare);
  if (lines > 0) {
    const lineBare = JSON.stringify({ Id: '1', Description: '', depth: 1 }).length;
    e.Line = Array.from({ length: lines }, (_, i) => ({ Id: String(i + 1), Description: 'd'.repeat(lineLen - lineBare - (String(i + 1).length - 1)) }));
  }
  return e;
}

/** A top-level report row whose line is exactly `n` characters. */
function reportRow(n: number): Record<string, unknown> {
  const bare = JSON.stringify({ ColData: [{ value: '' }], type: 'Data', depth: 0 }).length;
  return { ColData: [{ value: 'v'.repeat(n - bare) }], type: 'Data' };
}

/** WARNING items of at most 2,000 each (so none is cut) totalling exactly `n`. */
function padding(n: number): string[] {
  const k = Math.ceil(n / WARNING_MAX);
  return Array.from({ length: k }, (_, i) => {
    const size = Math.floor(n / k) + (i === 0 ? n % k : 0);
    return 'WARNING: ' + 'w'.repeat(size - 9);
  });
}

/** Shapes a search answer in upstream's one-array form. */
const searchOf = (rows: unknown[], c = call(), tool = 'search_purchases') => shapeResult(raw('Purchases found:', JSON.stringify(rows)), c, tool);

/** A cut search's maximality: the kept rows fit with their marker, and one more row with its marker doesn't (A5.10). */
function expectMaximal(rows: Record<string, unknown>[], result: CallToolResult, usedOffset = 1, inside = false) {
  const lines = dataOf(result).split('\n');
  const t = rows.length;
  const m = Number(/^truncated: (\d+) of/.exec(lines[0])![1]);
  const k = t - m;
  expect(length(result)).toBeLessThanOrEqual(RESULT_MAX);
  const warn = length(result) - dataOf(result).length;
  const one = render('rows', rows.slice(0, k + 1));
  expect([ROWS(m - 1, t, usedOffset + k + 1, inside), ...one].join('\n').length + warn).toBeGreaterThan(RESULT_MAX);
}

describe('toolKind: the 18 searches, the 11 reports, every other tool one line', () => {
  it('partitions the allowlist 18 / 11 / 2, and qbo_companies and unknown names are other', () => {
    const kinds = READ_ALLOWLIST.map(toolKind);
    expect(kinds.filter((k) => k === 'search')).toHaveLength(18);
    expect(kinds.filter((k) => k === 'report')).toHaveLength(11);
    expect(READ_ALLOWLIST.filter((t) => toolKind(t) === 'other')).toEqual(['get_company_info', 'get_preferences']);
    expect(toolKind('qbo_companies')).toBe('other');
    expect(toolKind('search_estimates')).toBe('other'); // not on the allowlist
    expect(toolKind('get_profit_and_loss')).toBe('report');
    expect(toolKind('search_purchases')).toBe('search');
  });
});

describe('D6: errorResult equals each get_company_info error fixture', () => {
  const failures: Record<string, Failure> = {
    'fork-error.json': { reason: 'fork-error' },
    'http-500.json': { reason: 'http-500', intuitTid: 'fake-tid-0001' },
    'name-mismatch-quickbooks.json': { reason: 'name-mismatch', source: 'quickbooks', reported: 'Garden Three Studio' },
    'name-mismatch-stacks.json': { reason: 'name-mismatch', source: 'stacks', reported: 'Garden Three LLC' },
    'not-connected.json': { reason: 'not-connected' },
    'renewal-failed-invalid_grant.json': { reason: 'renewal-failed:invalid_grant' },
    'renewal-failed-unavailable.json': { reason: 'renewal-failed:unavailable' },
    'stacks-auth.json': { reason: 'stacks-auth' },
    'stacks-unreachable.json': { reason: 'stacks-unreachable' },
    'timeout.json': { reason: 'timeout' },
    'unknown-enterprise.json': { reason: 'unknown-enterprise' },
  };

  it('every error fixture but the SDK one is listed here', () => {
    const files = readdirSync(fakePath('tool-results/get_company_info')).filter((f) => !f.startsWith('ok-') && f !== 'fork-error-sdk-input.json');
    expect(files.sort()).toEqual(Object.keys(failures).sort());
  });

  it.each(Object.entries(failures))('%s', (file, f) => {
    expect(errorResult(f, [])).toStrictEqual(fake(`tool-results/get_company_info/${file}`));
  });

  it('another renewal code takes the invalid_grant form; another status takes QuickBooks answered <status>.', () => {
    expect(dataOf(errorResult({ reason: 'renewal-failed:server_error' }, []))).toBe(
      "reason: renewal-failed:server_error\n\nStacks couldn't renew the QuickBooks sign-in; Intuit answered server_error (502).",
    );
    expect(dataOf(errorResult({ reason: 'http-404' }, []))).toBe('reason: http-404\n\nQuickBooks answered 404.');
    expect(REASON_TEXT['http-<status>']).toBe('QuickBooks answered <status>.');
    for (const code of ['AZ', 'az', '09', '_', '-', 'invalid_grant']) {
      expect(dataOf(errorResult({ reason: `renewal-failed:${code}` }, [])).split('\n')[0]).toBe(`reason: renewal-failed:${code}`);
    }
    for (const status of ['109', '900', '400']) {
      expect(dataOf(errorResult({ reason: `http-${status}` }, [])).split('\n')[0]).toBe(`reason: http-${status}`);
    }
    const code64 = 'a'.repeat(63) + '_';
    expect(dataOf(errorResult({ reason: `renewal-failed:${code64}` }, [])).split('\n')[0]).toBe(`reason: renewal-failed:${code64}`);
  });

  it('T6-3: a 400 without a fault, a 401 and a 403 use the default sentence; a 400 with a fault uses f.text', () => {
    expect(dataOf(errorResult({ reason: 'http-400' }, []))).toBe('reason: http-400\n\nQuickBooks answered 400.');
    expect(dataOf(errorResult({ reason: 'http-401', intuitTid: 'tid-1' }, []))).toBe('reason: http-401\nintuit_tid: tid-1\n\nQuickBooks answered 401.');
    expect(dataOf(errorResult({ reason: 'http-403' }, []))).toBe('reason: http-403\n\nQuickBooks answered 403.');
    const said = 'QuickBooks answered 400. QuickBooks said: Invalid query: near Name';
    expect(dataOf(errorResult({ reason: 'http-400', text: said }, []))).toBe(`reason: http-400\n\n${said}`);
  });

  it('a refusal keeps its own sentence under fork-error', () => {
    const text = 'The search was refused before reaching QuickBooks: x. Use limit up to 1000 and page with offset.';
    expect(dataOf(errorResult({ reason: 'fork-error', text }, []))).toBe(`reason: fork-error\n\n${text}`);
  });

  it('intuit_tid only with http-<status> and timeout, and only when it matches the pattern', () => {
    expect(dataOf(errorResult({ reason: 'timeout', intuitTid: 'abc-1' }, []))).toBe("reason: timeout\nintuit_tid: abc-1\n\nQuickBooks didn't answer within the server's limit.");
    expect(dataOf(errorResult({ reason: 'fork-error', intuitTid: 'abc-1' }, []))).toBe('reason: fork-error\n\nThe server failed before it could read QuickBooks.');
    expect(dataOf(errorResult({ reason: 'http-500', intuitTid: 'a'.repeat(64) }, [])).split('\n')[1]).toBe(`intuit_tid: ${'a'.repeat(64)}`);
    for (const good of ['AZ', 'az', '09', '-', 'Z-9a']) {
      expect(dataOf(errorResult({ reason: 'http-500', intuitTid: good }, [])).split('\n')[1]).toBe(`intuit_tid: ${good}`);
    }
    for (const bad of ['a'.repeat(65), '', 'a b', 'a\nreason: ok', 'a_b', 'x.y', 'a/b']) {
      expect(dataOf(errorResult({ reason: 'http-500', intuitTid: bad }, []))).toBe('reason: http-500\n\nQuickBooks answered 500.');
    }
  });

  it('T2-3: a reported name goes through the name rule: no control character, LF, CR or U+2028 reaches its line', () => {
    const r = dataOf(errorResult({ reason: 'name-mismatch', source: 'stacks', reported: ' Garden\nreason: ok\r Three\u0007 ' }, []));
    expect(r).toBe("reason: name-mismatch\nsource: stacks\nreported: Garden reason: ok  Three\n\nStacks' name for this company isn't one of its accepted names.");
  });

  it('a failure that breaks the grammar answers fork-error with its fixed text', () => {
    const forkError = fake('tool-results/get_company_info/fork-error.json');
    const broken: Failure[] = [
      { reason: 'http-5000' },
      { reason: 'http-50' },
      { reason: 'http-5x0' },
      { reason: `renewal-failed:${'a'.repeat(65)}` },
      { reason: 'renewal-failed:a b' },
      { reason: 'renewal-failed:a.b' },
      { reason: 'renewal-failed:a/b' },
      { reason: 'xname-mismatch', source: 'stacks', reported: 'Garden Three LLC' },
      { reason: 'name-mismatchx', source: 'stacks', reported: 'Garden Three LLC' },
      { reason: 'not-connected ' },
      { reason: ' unknown-enterprise' },
      { reason: 'stacks-authx' },
      { reason: 'xstacks-unreachable' },
      { reason: 'xhttp-500' },
      { reason: 'http-500x' },
      { reason: 'xrenewal-failed:a' },
      { reason: 'http-5a0' },
      { reason: 'xfork-error' },
      { reason: 'timeoutx' },
      { reason: 'reason: ok\nx' },
      { reason: 'renewal-failed:' },
      { reason: 'ok', text: 'free' },
      { reason: 'name-mismatch', source: 'stacks' },
      { reason: 'name-mismatch', source: 'stacks', reported: ' \n ' },
      { reason: 'name-mismatch', reported: 'Garden Three LLC' },
      { reason: 'name-mismatch', source: 'check' as 'stacks', reported: 'Garden Three LLC' },
    ];
    for (const f of broken) expect(errorResult(f, [])).toStrictEqual(forkError);
  });

  it('A4.7: the warnings follow the error item, each cut at 2,000 as on a success', () => {
    const long = `WARNING: ${'w'.repeat(2500)}`;
    const r = errorResult({ reason: 'name-mismatch', source: 'quickbooks', reported: 'Garden Three Studio' }, ['WARNING: a', long]);
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(3);
    expect(dataOf(r).startsWith('reason: name-mismatch\nsource: quickbooks\nreported: Garden Three Studio\n\n')).toBe(true);
    expect((r.content[1] as { text: string }).text).toBe('WARNING: a');
    expect((r.content[2] as { text: string }).text).toBe(`${long.slice(0, 1956)}\n${WARNING_CUT}`);
  });

  it('no token or key reaches a result: the store holds one, no result carries it', () => {
    const token = ['qbo', 'secret', 'x', String(Date.now())].join('-');
    const c = call({ token, realm: '9990000000000002', failure: { reason: 'http-500' } });
    expect(JSON.stringify(shapeResult(raw('Error: x'), c, 'search_purchases'))).not.toContain(token);
    expect(JSON.stringify(shapeResult(raw('{"a":1}'), { ...c, failure: null }, 'get_preferences'))).not.toContain(token);
  });
});

describe('A5.10: a WARNING item over 2,000 is cut to its longest prefix, never splitting a pair', () => {
  const W = (n: number) => 'WARNING: ' + 'x'.repeat(n - 9);
  it('2,000 untouched, 2,001 cut to exactly 2,000', () => {
    expect(cutWarning(W(2000))).toBe(W(2000));
    const cutOne = cutWarning(W(2001));
    expect(cutOne).toBe(`${W(2001).slice(0, 1956)}\n${WARNING_CUT}`);
    expect(cutOne.length).toBe(WARNING_MAX);
  });
  it('an emoji across the bound keeps neither half; one just inside, a lone high surrogate, or a high one before U+E000 stays', () => {
    const across = W(1955) + '\u{1F600}' + 'x'.repeat(100);
    expect(cutWarning(across)).toBe(`${W(1955)}\n${WARNING_CUT}`);
    const inside = W(1954) + '\u{1F600}' + 'x'.repeat(100);
    expect(cutWarning(inside)).toBe(`${W(1954)}\u{1F600}\n${WARNING_CUT}`);
    const lone = W(1955) + '\uD83Dx' + 'x'.repeat(100);
    expect(cutWarning(lone)).toBe(`${W(1955)}\uD83D\n${WARNING_CUT}`);
    const beforeE000 = W(1955) + '\uD83D' + 'x'.repeat(100);
    expect(cutWarning(beforeE000)).toBe(`${W(1955)}\uD83D\n${WARNING_CUT}`);
  });
  it('the pair bounds exactly: U+10000 and U+10FFFF across the bound are dropped; D7FF, a low unit, or DBFF after a high one stay', () => {
    const at = (pair: string) => cutWarning(W(1955) + pair + 'x'.repeat(100));
    expect(at('𐀀')).toBe(`${W(1955)}\n${WARNING_CUT}`);
    expect(at('􏿿')).toBe(`${W(1955)}\n${WARNING_CUT}`);
    expect(at('퟿\uDC00')).toBe(`${W(1955)}퟿\n${WARNING_CUT}`);
    expect(at('\uDC00\uDC00')).toBe(`${W(1955)}\uDC00\n${WARNING_CUT}`);
    expect(at('\uD83D\uDBFF')).toBe(`${W(1955)}\uD83D\n${WARNING_CUT}`);
  });

  it('on a success the cut warning follows the data item', () => {
    const across = W(1955) + '\u{1F600}' + 'x'.repeat(100);
    const r = shapeResult({ content: [item('{"a":1}'), item(across)] }, call(), 'get_preferences');
    expect(r.content).toStrictEqual([item('{"a":1}'), item(`${W(1955)}\n${WARNING_CUT}`)]);
  });
  it('on an error the cut warning follows the error item', () => {
    const across = W(1955) + '\u{1F600}' + 'x'.repeat(100);
    const r = shapeResult({ content: [item('Error: x'), item(across)] }, call(), 'get_preferences');
    expect(r.content[1]).toStrictEqual(item(`${W(1955)}\n${WARNING_CUT}`));
  });
});

describe('D9 and A4.7: classify', () => {
  const failsOn = (r: unknown, kind: 'search' | 'report' | 'other') => expect(classify(r, kind).ok).toBe(false);

  it.each([
    ['an Error: text without isError', raw('Error: boom')],
    ["upstream's Error searching purchases: text", raw('Error searching purchases: boom')],
    ['isError true with no header', { content: [item('anything')], isError: true }],
    ['isError with a header whose code is not in the table', { content: [item('reason: ok\n\nfine')], isError: true }],
    ['isError true over valid JSON', { content: [item('[]')], isError: true }],
    ['isError neither true nor false', { content: [item('[]')], isError: 'yes' }],
    ['Invalid criteria: from a tool file', raw('Invalid criteria: [{"code":"invalid_union"}]')],
    ['a one-line Error searching: x: (never a label)', raw('Error searching: x:')],
    ['a label after a JSON item', raw('[]', 'Purchases found:')],
    ['a two-line label', raw('Found 3 bills:\nmore:', '[]')],
    ['a label holding a CR', raw('Found 3 bills\r:', '[]')],
    ['a label holding a quote', raw('"Found":', '[]')],
    ['a label holding a brace', raw('Found {3}:', '[]')],
    ['a label holding a bracket', raw('Found [3]:', '[]')],
    ['Found with a capital thing', raw('Found 2 Invoices', '[]')],
    ['Found with something after the thing', raw('Found 2 invoices.', '[]')],
    ['Found with no digits (T9-1)', raw('Found  invoices', '[]')],
    ['Found with no thing (T9-1)', raw('Found 2 ', '[]')],
    ['Found not at the start (T9-1)', raw('Not Found 2 invoices', '[]')],
    ['Found with no space before the digits', raw('Found2 invoices', '[]')],
    ['Found with no space before the thing', raw('Found 2invoices', '[]')],
    ['Found with a letter for a digit', raw('Found x invoices', '[]')],
    ['Found with a digit in the thing', raw('Found 2 invoice5', '[]')],
    ['Found with two words', raw('Found 2 bill payments', '[]')],
    ['an array of arrays', raw('Purchases found:', '[[{"Id":"1"}]]')],
    ['any other text', raw('Purchases found', '[]')],
    ['a JSON item that is not a row', raw('Purchases found:', '5')],
    ['an array holding a non-object', raw('Purchases found:', '[{"Id":"1"},null]')],
    ['an item that is not text', { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }, item('[]')] }],
    ['a text item whose text is not a string', { content: [{ type: 'text', text: 5 }] }],
    ['no content', {}],
    ['not an object', null],
    ['only WARNING items', raw('WARNING: a')],
    ['a WARNING-like text without the colon (not set aside)', raw('[]', 'WARNINGS: not a warning item')],
    ['empty content', { content: [] }],
  ])('search: %s is an error', (_label, r) => failsOn(r, 'search'));

  it('a success whose data happens to start Error (a JSON string) is untouched', () => {
    expect(classify(raw('"Error: not one"'), 'other')).toEqual({ ok: true, kind: 'object', value: 'Error: not one', warnings: [] });
    expect(shapeResult(raw('"Error: not one"'), call(), 'get_preferences').content).toStrictEqual([item('"Error: not one"')]);
  });

  it('labels: ending : or Found <n> <things>, only before the JSON items, more than one allowed', () => {
    const row = { Id: '1' };
    for (const label of ['Purchases found:', 'Found 3 bills:', 'Profit and Loss Report:', 'Found 2 invoices', 'Found 0 items', 'Found 90 zebras', 'Found 1 a']) {
      expect(classify(raw(label, JSON.stringify([row])), 'search')).toEqual({ ok: true, kind: 'rows', value: [row], warnings: [] });
    }
    expect(classify(raw('Found 1 bills:', 'Also:', JSON.stringify(row)), 'search')).toEqual({ ok: true, kind: 'rows', value: [row], warnings: [] });
    expect(classify({ content: [item('[]')], isError: false }, 'search')).toEqual({ ok: true, kind: 'rows', value: [], warnings: [] });
  });

  it('A5.6: the one-item-per-row form gives the same rows as the one-array form; a label alone gives no rows', () => {
    const rows = [{ Id: '1', DueDate: '2026-10-01', Balance: 5 }, { Id: '2' }];
    const perRow = shapeResult(raw('Found 2 bills:', ...rows.map((r) => JSON.stringify(r))), call(), 'search_bills');
    const oneArray = shapeResult(raw('Bills found:', JSON.stringify(rows)), call(), 'search_bills');
    expect(perRow).toStrictEqual(oneArray);
    expect(dataOf(perRow)).toBe('{"Id":"1","DueDate":"2026-10-01","Balance":5,"depth":0}\n{"Id":"2","depth":0}');
    expect(shapeResult(raw('Found 0 bills:'), call(), 'search_bills')).toStrictEqual({ content: [item('')] });
    expect(shapeResult(raw('Found 0 invoices'), call(), 'search_invoices')).toStrictEqual({ content: [item('')] });
  });

  it('A5.4 and A5.6: Count: 3 gives exactly search_bills/count.json; Count: 7 with a WARNING item keeps it after', () => {
    expect(shapeResult(raw('Count: 3'), call(), 'search_bills')).toStrictEqual(fake('tool-results/search_bills/count.json'));
    expect(shapeResult(raw('Count: 7', 'WARNING: w'), call(), 'search_bills').content).toStrictEqual([item('{"count":7}'), item('WARNING: w')]);
    expect(shapeResult(raw('WARNING: w', 'Count: 7'), call(), 'search_bills').content).toStrictEqual([item('{"count":7}'), item('WARNING: w')]);
  });

  it('the count form is exactly one Count: <n> item on a search', () => {
    failsOn(raw('Count: 3'), 'other');
    failsOn(raw('Count: 3'), 'report');
    failsOn(raw('Count: 3', '[]'), 'search');
    failsOn(raw('Count: x'), 'search');
    failsOn(raw('Count: 3 '), 'search');
    failsOn(raw(' Count: 3'), 'search');
    failsOn(raw('Count: '), 'search');
    failsOn(raw('Count: x3'), 'search');
    failsOn(raw('xCount: 3'), 'search');
    failsOn(raw('Count:3'), 'search');
    failsOn(raw('Count 3'), 'search');
    expect(classify(raw('Count: 90'), 'search')).toEqual({ ok: true, kind: 'count', value: 90, warnings: [] });
  });

  it('a count is never cut', () => {
    const big = 'WARNING: ' + 'x'.repeat(1991);
    const warnings = Array.from({ length: 16 }, () => big); // 32,000 of warnings
    expect(cut('count', ['{"count":3}'], warnings, 1, false).lines).toEqual(['{"count":3}']);
  });

  it('A4.7: a label-only get_preferences, two JSON items on a non-search tool, and no text item are fork-error', () => {
    const forkError = fake('tool-results/get_company_info/fork-error.json');
    expect(shapeResult(raw('Preferences:'), call(), 'get_preferences')).toStrictEqual(forkError);
    expect(shapeResult(raw('{"a":1}', '{"b":2}'), call(), 'get_preferences')).toStrictEqual(forkError);
    expect(shapeResult(raw('Profit and Loss Report:', '{"Header":{},"Columns":{}}', '{}'), call(), 'get_profit_and_loss')).toStrictEqual(forkError);
    expect(shapeResult({ content: [] }, call(), 'get_preferences')).toStrictEqual(forkError);
    expect(shapeResult({ content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] }, call(), 'get_preferences')).toStrictEqual(forkError);
    expect(shapeResult(undefined, call(), 'get_company_info')).toStrictEqual(forkError);
  });

  it('a report is an object with Header and Columns whose Rows are valid', () => {
    for (const bad of ['[]', '5', '{"Columns":{}}', '{"Header":{}}', '{"Header":{},"Columns":{},"Rows":[]}', '{"Header":{},"Columns":{},"Rows":{"Row":{}}}',
      '{"Header":{},"Columns":{},"Rows":{"Row":[5]}}', '{"Header":{},"Columns":{},"Rows":{"Row":[{"Rows":{"Row":[null]}}]}}', '{"Header":{},"Columns":{},"Rows":null}']) {
      failsOn(raw('Report:', bad), 'report');
    }
    expect(classify(raw('{"Header":{},"Columns":{},"Rows":{"Row":[{"Rows":{}}]}}'), 'report').ok).toBe(true);
  });

  it('A4.7: a recorded failure decides first, whatever the text says (a 500 then Found 0 invoices is http-500)', () => {
    const c = call({ failure: { reason: 'http-500', intuitTid: 'tid-9' } });
    expect(shapeResult(raw('Found 0 invoices'), c, 'search_invoices')).toStrictEqual({
      content: [item('reason: http-500\nintuit_tid: tid-9\n\nQuickBooks answered 500.')],
      isError: true,
    });
  });

  it('an error result carries the call warnings then the handler WARNING items, after the error item', () => {
    const r = shapeResult(raw('WARNING: handler', 'Error: x'), call({ warnings: ['WARNING: call'] }), 'search_purchases');
    expect(r).toStrictEqual({ content: [item('reason: fork-error\n\nThe server failed before it could read QuickBooks.'), item('WARNING: call'), item('WARNING: handler')], isError: true });
  });
});

describe('A5.4: search rows', () => {
  it('render/search_purchases.json gives exactly tool-results/search_purchases/ok.json', () => {
    expect(searchOf(fake('render/search_purchases.json'))).toStrictEqual(fake('tool-results/search_purchases/ok.json'));
  });

  it('each header line is the entity minus Line with depth 0 last, then each Line whole with depth 1 last; other arrays stay', () => {
    const e = { Id: '7', LinkedTxn: [{ TxnId: '1' }], Line: [{ Id: '1', LinkedTxn: [{ TxnId: '2' }] }, { Id: '2' }], TotalAmt: 3 };
    expect(render('rows', [e, { Id: '8', Line: [] }])).toEqual([
      '{"Id":"7","LinkedTxn":[{"TxnId":"1"}],"TotalAmt":3,"depth":0}',
      '{"Id":"1","LinkedTxn":[{"TxnId":"2"}],"depth":1}',
      '{"Id":"2","depth":1}',
      '{"Id":"8","depth":0}',
    ]);
  });

  it('a Line that is not an array of objects stays inside its header line', () => {
    expect(render('rows', [{ Id: '1', Line: 'x' }, { Id: '2', Line: [{ Id: '1' }, 5] }])).toEqual([
      '{"Id":"1","Line":"x","depth":0}',
      '{"Id":"2","Line":[{"Id":"1"},5],"depth":0}',
    ]);
  });

  it('memo LF and CR are escaped on one line, U+2028 stays raw, and each line parses back to the same string', () => {
    const memo = 'line one\nline two\rthree four';
    const r = searchOf([{ Id: '1', PrivateNote: memo, Line: [{ Id: '1', Description: memo }] }]);
    const lines = dataOf(r).split('\n');
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toContain('line one\\nline two\\rthree four');
      expect(l).not.toContain('\r');
    }
    expect(JSON.parse(lines[0]).PrivateNote).toBe(memo);
    expect(JSON.parse(lines[1]).Description).toBe(memo);
  });

  it('round trip: parsing the lines back, dropping depth and putting Line back gives each entity deep-equal', () => {
    const purchases = fake('render/search_purchases.json');
    const bill = { Id: '9', DueDate: '2026-11-01', Balance: 12.5, Line: [{ Id: '1', Amount: 12.5 }] };
    const journal = { Id: '10', Line: [{ Id: '0', JournalEntryLineDetail: { PostingType: 'Debit' } }, { Id: '1', JournalEntryLineDetail: { PostingType: 'Credit' } }] };
    const all = [...purchases, bill, journal];
    const back: Record<string, any>[] = [];
    for (const line of dataOf(searchOf(all)).split('\n')) {
      const { depth, ...v } = JSON.parse(line);
      if (depth === 0) back.push(v);
      else (back[back.length - 1].Line ??= []).push(v);
    }
    expect(back).toEqual(all);
    expect(purchases.some((p: any) => 'AccountRef' in p && 'PaymentType' in p && 'Credit' in p)).toBe(true);
  });
});

describe('A5.5 and A5.5b: report rows and other tools', () => {
  it('render/ProfitAndLoss.json gives exactly tool-results/get_profit_and_loss/ok.json', () => {
    const r = shapeResult(raw('Profit and Loss Report:', pretty(fake('render/ProfitAndLoss.json'))), call(), 'get_profit_and_loss');
    expect(r).toStrictEqual(fake('tool-results/get_profit_and_loss/ok.json'));
  });

  it('a nested P&L by month (sections two deep, 13 columns) round-trips by depth', () => {
    const cols = (label: string) => [{ value: label }, ...Array.from({ length: 12 }, (_, i) => ({ value: `${i + 1}.00` }))];
    const report = {
      Header: { ReportName: 'ProfitAndLoss', SummarizeColumnsBy: 'Month', StartPeriod: '2026-01-01', EndPeriod: '2026-12-31' },
      Columns: { Column: [{ ColTitle: '', ColType: 'Account' }, ...Array.from({ length: 12 }, (_, i) => ({ ColTitle: `M${i + 1}`, ColType: 'Money' }))] },
      Rows: {
        Row: [
          {
            Header: { ColData: cols('Expenses') },
            Rows: { Row: [{ Header: { ColData: cols('Software') }, Rows: { Row: [{ ColData: cols('Hosting'), type: 'Data' }] }, Summary: { ColData: cols('Total Software') }, type: 'Section' }, { ColData: cols('Rent'), type: 'Data' }] },
            Summary: { ColData: cols('Total Expenses') },
            type: 'Section',
            group: 'Expenses',
          },
          { Summary: { ColData: cols('Net Income') }, type: 'Section' },
        ],
      },
    };
    const lines = render('report', report);
    expect(lines.slice(0, 2)).toEqual([JSON.stringify(report.Header), JSON.stringify(report.Columns)]);
    const top: any[] = [];
    const stack: any[] = [];
    for (const line of lines.slice(2)) {
      const { depth, ...row } = JSON.parse(line);
      expect(line.endsWith(`"depth":${depth}}`)).toBe(true);
      if (depth === 0) top.push(row);
      else ((stack[depth - 1].Rows ??= { Row: [] }).Row as any[]).push(row);
      stack[depth] = row;
    }
    expect({ Header: report.Header, Columns: report.Columns, Rows: { Row: top } }).toEqual(report);
    expect(lines.map((l) => JSON.parse(l).depth)).toEqual([undefined, undefined, 0, 1, 2, 1, 0]);
  });

  it('a report with NoReportData and no Rows, an empty Rows or an empty Row is lines 1 and 2 only', () => {
    const H = { ReportName: 'ProfitAndLoss', Option: [{ Name: 'NoReportData', Value: 'true' }] };
    for (const rows of [undefined, {}, { Row: [] }]) {
      expect(render('report', { Header: H, Columns: { Column: [] }, Rows: rows })).toEqual([JSON.stringify(H), '{"Column":[]}']);
    }
  });

  it('A5.5b: a get_preferences answer (2-space upstream) renders as one compact line', () => {
    const prefs = { Preferences: { AccountingInfoPrefs: { TrackDepartments: true, ClassTrackingPerTxn: false }, Id: '1' } };
    expect(shapeResult(raw(pretty(prefs)), call(), 'get_preferences')).toStrictEqual({ content: [item(JSON.stringify(prefs))] });
  });

  it('A5.5b: get_company_info renders its ok fixture exactly', () => {
    const ok = fake('tool-results/get_company_info/ok-garden3d.json');
    expect(shapeResult(raw(pretty(JSON.parse(dataOf(ok)))), call(), 'get_company_info')).toStrictEqual(ok);
  });
});

describe('A5.10, A5.11, A5.12: the cut fixtures', () => {
  it('render/search_purchases-long.json gives exactly search_purchases/truncated-rows.json, and the cut is maximal', () => {
    const rows = fake('render/search_purchases-long.json');
    const r = searchOf(rows);
    expect(r).toStrictEqual(fake('tool-results/search_purchases/truncated-rows.json'));
    expectMaximal(rows, r);
  });

  it('render/search_purchases-long-row.json gives exactly search_purchases/truncated-lines.json', () => {
    expect(searchOf(fake('render/search_purchases-long-row.json'))).toStrictEqual(fake('tool-results/search_purchases/truncated-lines.json'));
  });

  it('render/ProfitAndLoss-long.json gives exactly get_profit_and_loss/truncated-rows.json', () => {
    const r = shapeResult(raw('Profit and Loss Report:', pretty(fake('render/ProfitAndLoss-long.json'))), call(), 'get_profit_and_loss');
    expect(r).toStrictEqual(fake('tool-results/get_profit_and_loss/truncated-rows.json'));
  });

  it('render/get_preferences-long.json gives exactly get_preferences/truncated-object.json', () => {
    const r = shapeResult(raw(pretty(fake('render/get_preferences-long.json'))), call(), 'get_preferences');
    expect(r).toStrictEqual(fake('tool-results/get_preferences/truncated-object.json'));
  });
});

describe('A5.10: the bound', () => {
  it('an object of exactly 30,000 is untouched; 30,001 is its marker alone', () => {
    const exact = { a: 'x'.repeat(RESULT_MAX - 8) };
    expect(JSON.stringify(exact).length).toBe(RESULT_MAX);
    expect(shapeResult(raw(JSON.stringify(exact)), call(), 'get_preferences').content).toStrictEqual([item(JSON.stringify(exact))]);
    const over = { a: 'x'.repeat(RESULT_MAX - 7) };
    expect(shapeResult(raw(JSON.stringify(over)), call(), 'get_preferences').content).toStrictEqual([item(OBJECT)]);
  });

  it('every WARNING item counts: 29,000 of data and 1,000 of warning is untouched, one more character cuts', () => {
    const w = 'WARNING: ' + 'w'.repeat(991);
    const at = { a: 'x'.repeat(29000 - 8) };
    expect(shapeResult(raw(JSON.stringify(at), w), call(), 'get_preferences').content).toStrictEqual([item(JSON.stringify(at)), item(w)]);
    const past = { a: 'x'.repeat(29000 - 7) };
    expect(shapeResult(raw(JSON.stringify(past), w), call(), 'get_preferences').content).toStrictEqual([item(OBJECT), item(w)]);
  });

  it('search rows totalling exactly 30,000 are untouched; 30,001 cuts to the most whole rows that fit', () => {
    // 30 rows of 999 characters and 29 LFs is 29,999; the last row one longer makes 30,000.
    const rows = Array.from({ length: 30 }, (_, i) => entity(i + 1, i === 29 ? 1000 : 999));
    const r = searchOf(rows);
    expect(length(r)).toBe(RESULT_MAX);
    expect(dataOf(r).startsWith('{')).toBe(true);
    const over = Array.from({ length: 30 }, (_, i) => entity(i + 1, i === 29 ? 1001 : 999));
    const c = searchOf(over);
    expect(dataOf(c).split('\n')[0]).toBe(ROWS(1, 30, 30));
    expect(dataOf(c).split('\n')).toHaveLength(30);
    expectMaximal(over, c);
  });

  it('a cut search keeps exactly the rows that fit with the marker: one character less room drops one more row', () => {
    // 40 rows of 700 (each 701 with its LF) and a marker of 59: 21 rows fit in 14,780.
    const rows = Array.from({ length: 40 }, (_, i) => entity(i + 1, 700));
    const marker = ROWS(19, 40, 22);
    const room = marker.length + 21 * 701;
    const fits = cut('rows', render('rows', rows), padding(RESULT_MAX - room), 1, false, searchRowSizes(rows));
    expect(fits.lines[0]).toBe(marker);
    expect(fits.lines).toHaveLength(22);
    expect(fits.lines.join('\n').length).toBe(room);
    const tight = cut('rows', render('rows', rows), padding(RESULT_MAX - room + 1), 1, false, searchRowSizes(rows));
    expect(tight.lines[0]).toBe(ROWS(20, 40, 21));
  });

  it('a report of exactly 30,000 is untouched, 30,001 is cut, and the cut is maximal', () => {
    const report = (last: number) => ({
      Header: { R: 'P' },
      Columns: { Column: [] },
      Rows: { Row: Array.from({ length: 30 }, (_, i) => reportRow(i === 29 ? last : 990)) },
    });
    const at = render('report', report(990));
    const fill = RESULT_MAX - at.join('\n').length;
    const exact = render('report', report(990 + fill));
    expect(exact.join('\n').length).toBe(RESULT_MAX);
    expect(cut('report', exact, [], 1, false).lines).toBe(exact);
    const past = render('report', report(991 + fill));
    const c = cut('report', past, [], 1, false);
    expect(c.lines[0]).toBe(REPORT(1, 30));
    expect(c.lines).toEqual([REPORT(1, 30), ...past.slice(0, 31)]);
    expect(c.lines.join('\n').length).toBeLessThanOrEqual(RESULT_MAX);
  });

  it('a report keeps the most rows that fit: one character less room drops one more', () => {
    const rows = Array.from({ length: 40 }, () => reportRow(700));
    const lines = render('report', { Header: { R: 'P' }, Columns: { Column: [] }, Rows: { Row: rows } });
    expect(lines[2].length).toBe(700);
    const fixed = lines[0].length + 1 + lines[1].length;
    const room = REPORT(19, 40).length + 1 + fixed + 21 * 701;
    const fits = cut('report', lines, padding(RESULT_MAX - room), 1, false);
    expect(fits.lines[0]).toBe(REPORT(19, 40));
    expect(fits.lines).toHaveLength(24);
    expect(fits.lines.join('\n').length).toBe(room);
    expect(cut('report', lines, padding(RESULT_MAX - room + 1), 1, false).lines[0]).toBe(REPORT(20, 40));
  });
});

describe('A5.10 and A5.12: when nothing fits (contract §5 Cuts; one built case each)', () => {
  let wideReport: Record<string, unknown>;
  let longRowLines: Record<string, unknown>[];
  beforeAll(() => {
    // A P&L by Classes with 600 columns: its Columns line alone is past 30,000.
    const Column = Array.from({ length: 600 }, (_, i) => ({ ColTitle: `Class ${String(i).padStart(3, '0')} studio`, ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: `class-${i}` }] }));
    const ColData = Array.from({ length: 600 }, () => ({ value: '1.00' }));
    wideReport = {
      Header: { ReportName: 'ProfitAndLoss', SummarizeColumnsBy: 'Classes' },
      Columns: { Column },
      Rows: { Row: [{ ColData, type: 'Data' }, { ColData, type: 'Data' }, { Summary: { ColData }, type: 'Section' }] },
    };
    // A first row of 510 Lines whose header fits alone but not with the marker and the warning.
    longRowLines = [entity(1, 29000, 510, 60), entity(2, 100), entity(3, 100)];
  });

  it('a report whose Header and Columns pass 30,000 with the marker keeps those two lines, every row dropped, <m> = <t>', () => {
    const r = shapeResult(raw('Profit and Loss Report:', JSON.stringify(wideReport)), call(), 'get_profit_and_loss');
    const lines = dataOf(r).split('\n');
    expect(lines).toEqual([REPORT(3, 3), JSON.stringify(wideReport.Header), JSON.stringify(wideReport.Columns)]);
    expect(length(r)).toBeGreaterThan(RESULT_MAX);
  });

  it('the same report with no rows has nothing left out: no marker, uncut', () => {
    const noRows = { Header: wideReport.Header, Columns: wideReport.Columns };
    const r = shapeResult(raw(JSON.stringify(noRows)), call(), 'get_profit_and_loss');
    expect(dataOf(r)).toBe(`${JSON.stringify(noRows.Header)}\n${JSON.stringify(noRows.Columns)}`);
    expect(length(r)).toBeGreaterThan(RESULT_MAX);
  });

  it('a first row whose header fits alone but not with the marker and the warnings, with Lines: truncated-lines, <l> = <L>', () => {
    const header = render('rows', [longRowLines[0]])[0];
    const w = 'WARNING: ' + 'w'.repeat(RESULT_MAX - header.length - 9 - 20);
    expect(header.length + w.length).toBeLessThanOrEqual(RESULT_MAX);
    const r = shapeResult(raw('Purchases found:', JSON.stringify(longRowLines), w), call({ usedOffset: 5 }), 'search_purchases');
    expect(r.content).toStrictEqual([item(`${LINES(510, 510, 2, 3, 6)}\n${header}`), item(w)]);
    expect(length(r)).toBeGreaterThan(RESULT_MAX);
  });

  it('a first row cut to its first Lines: the most that fit, every later row dropped, <o> past that row', () => {
    const r = shapeResult(raw('Purchases found:', JSON.stringify(longRowLines)), call({ usedOffset: 101 }), 'search_invoices');
    const lines = dataOf(r).split('\n');
    const l = Number(/^truncated: (\d+) of 510/.exec(lines[0])![1]);
    expect(lines[0]).toBe(LINES(l, 510, 2, 3, 102, true));
    expect(lines).toHaveLength(2 + 510 - l);
    expect(length(r)).toBeLessThanOrEqual(RESULT_MAX);
    const all = render('rows', [longRowLines[0]]);
    expect([LINES(l - 1, 510, 2, 3, 102, true), ...all.slice(0, 1 + 511 - l)].join('\n').length).toBeGreaterThan(RESULT_MAX);
  });

  it('a single row of Lines over the cut keeps the most of its Lines, <m> = 0', () => {
    const r = searchOf([entity(1, 1000, 1000, 60)]);
    const first = dataOf(r).split('\n')[0];
    const l = Number(/^truncated: (\d+) of 1000/.exec(first)![1]);
    expect(first).toBe(LINES(l, 1000, 0, 1, 2));
    expect(length(r)).toBeLessThanOrEqual(RESULT_MAX);
    expect(length(r)).toBeGreaterThan(RESULT_MAX - 62);
  });

  it('a first row cut to its Lines keeps exactly the Lines that fit: an exact fit is kept, one character less drops one', () => {
    const rows = [entity(1, 2000, 100, 200), entity(2, 100), entity(3, 100)]; // a Line longer than the two markers differ
    const header = render('rows', [rows[0]])[0];
    const room = (l: number) => LINES(l, 100, 2, 3, 2).length + 1 + header.length + (100 - l) * 201;
    const at = (l: number, extra = 0) => cut('rows', render('rows', rows), padding(RESULT_MAX - room(l) + extra), 1, false, searchRowSizes(rows)).lines;
    expect(at(50)[0]).toBe(LINES(50, 100, 2, 3, 2));
    expect(at(50)).toHaveLength(52);
    expect(at(50).join('\n').length).toBe(room(50));
    expect(at(50, 1)[0]).toBe(LINES(51, 100, 2, 3, 2));
    expect(at(1)[0]).toBe(LINES(1, 100, 2, 3, 2)); // all but the last Line
    expect(at(1)).toHaveLength(101);
  });

  it('a first row with Lines that fits whole with the marker, the second not: truncated-rows keeping that whole row', () => {
    const rows = [entity(1, 1000, 10, 60), entity(2, 29500), entity(3, 100)];
    const r = searchOf(rows);
    expect(dataOf(r)).toBe([ROWS(2, 3, 2), ...render('rows', [rows[0]])].join('\n'));
  });

  it('a Line-less first row that does not fit with the marker, followed by others: truncated-rows, <m> = <t> - 1', () => {
    const rows = [entity(1, 29990), entity(2, 100), entity(3, 100)];
    const r = searchOf(rows);
    expect(dataOf(r)).toBe(`${ROWS(2, 3, 2)}\n${render('rows', [rows[0]])[0]}`);
    expect(length(r)).toBeGreaterThan(RESULT_MAX);
  });

  it('a single Line-less row over the cut has nothing left out: no marker, uncut', () => {
    const only = entity(1, 30500);
    const r = searchOf([only]);
    expect(r.content).toStrictEqual([item(render('rows', [only])[0])]);
  });
});

describe('A5.11: the next offset', () => {
  let rows: Record<string, unknown>[];
  beforeAll(() => {
    rows = fake('render/search_purchases-long.json'); // 21 rows kept
  });

  it('a first page of n kept rows names offset n+1', () => {
    expect(dataOf(searchOf(rows)).split('\n')[0]).toBe(ROWS(59, 80, 22));
  });

  it('a call with offset 101 keeping 40 names 141', () => {
    const forty = Array.from({ length: 50 }, (_, i) => entity(i + 1, 740));
    const r = searchOf(forty, call({ usedOffset: 101 }));
    expect(dataOf(r).split('\n')[0]).toBe(ROWS(10, 50, 141));
    expectMaximal(forty, r, 101);
  });

  const shapes: [string, () => ReturnType<typeof normalizeSearch>][] = [
    ['a top-level offset', () => normalizeSearch('search_purchases', {}, { offset: 101 })],
    ['offset in a criteria object', () => normalizeSearch('search_purchases', { offset: 101 })],
    ['a {field: offset} entry in a criteria array', () => normalizeSearch('search_purchases', [{ field: 'offset', value: 101 }])],
    ['a record in a criteria array', () => normalizeSearch('search_purchases', [{ Offset: 101 }])],
    ['one {field: offset} criterion object', () => normalizeSearch('search_purchases', { field: 'offset', value: 101 })],
    ['a criterion object with offset beside it', () => normalizeSearch('search_purchases', { field: 'Id', value: '1', offset: 101 })],
    ['a built search', () => normalizeBuiltSearch('search_purchases', { Offset: 101, limit: 5 })],
  ];

  it.each(shapes)('%s: the normalizer\'s used offset, not params.offset, names 122', async (_label, normalize) => {
    const first = await runInCall('garden3d', async () => {
      const n = normalize();
      if (!n.ok) throw new Error('refused');
      setUsedOffset(n.usedOffset);
      return searchOf(rows, currentCall() as CallStore);
    });
    expect(dataOf(first).split('\n')[0]).toBe(ROWS(59, 80, 122));
  });

  it('no offset on the call is offset 1', async () => {
    const r = await runInCall('garden3d', async () => searchOf(rows, currentCall() as CallStore));
    expect(dataOf(r).split('\n')[0]).toBe(ROWS(59, 80, 22));
  });

  it.each(SEARCH_TOOLS)('%s: inside criteria for the three, a bare offset for the other 15', (tool) => {
    expect(SEARCH_TOOLS).toHaveLength(18);
    const inside = CRITERIA_THREE.includes(tool);
    const r = searchOf(rows, call({ usedOffset: 101 }), tool);
    expect(dataOf(r).split('\n')[0]).toBe(ROWS(59, 80, 122, inside));
    const lines = searchOf(fake('render/search_purchases-long-row.json'), call(), tool);
    expect(dataOf(lines).split('\n')[0]).toBe(LINES(35, 120, 2, 3, 2, inside));
  });
});

describe('T9-2: an empty data item, or no room at all, is never cut and never throws', () => {
  // 16 warnings of 2,000: 32,000 of warnings alone, so the room for the data item is below zero.
  const over = Array.from({ length: 16 }, () => 'WARNING: ' + 'w'.repeat(1991));

  it('a search with no rows under warnings over 30,000: the empty data item, no marker', () => {
    expect(cut('rows', [], over, 1, false)).toEqual({ lines: [], warnings: over });
    expect(cut('rows', [], over, 1, false, [])).toEqual({ lines: [], warnings: over });
    const r = shapeResult(raw('Found 0 bills:', ...over), call(), 'search_bills');
    expect(r.content).toStrictEqual([item(''), ...over.map(item)]);
  });

  it('a report, an object and a count with no lines are returned as they are', () => {
    for (const kind of ['report', 'object', 'count'] as const) expect(cut(kind, [], over, 1, false).lines).toEqual([]);
  });

  it('a report of Header and Columns only, or fewer lines, under no room: no marker', () => {
    expect(cut('report', ['{"R":"P"}', '{"Column":[]}'], over, 1, false).lines).toEqual(['{"R":"P"}', '{"Column":[]}']);
    expect(cut('report', ['{"R":"P"}'], over, 1, false).lines).toEqual(['{"R":"P"}']);
  });

  it('with no room, a report keeps Header and Columns and drops every row; an object is its marker', () => {
    expect(cut('report', ['{"R":"P"}', '{"Column":[]}', '{"depth":0}'], over, 1, false).lines).toEqual([REPORT(1, 1), '{"R":"P"}', '{"Column":[]}']);
    expect(cut('object', ['{}'], over, 1, false).lines).toEqual([OBJECT]);
    expect(cut('count', ['{"count":1}'], over, 1, false).lines).toEqual(['{"count":1}']);
  });

  it('with no room, a search keeps its first header line: Lines dropped, or later rows dropped, or one row uncut', () => {
    const withLines = [{ Id: '1', Line: [{ Id: '1' }, { Id: '2' }] }, { Id: '2' }];
    expect(cut('rows', render('rows', withLines), over, 1, false, searchRowSizes(withLines)).lines).toEqual([LINES(2, 2, 1, 2, 2), '{"Id":"1","depth":0}']);
    const bare = [{ Id: '1' }, { Id: '2' }];
    expect(cut('rows', render('rows', bare), over, 1, false, searchRowSizes(bare)).lines).toEqual([ROWS(1, 2, 2), '{"Id":"1","depth":0}']);
    expect(cut('rows', ['{"Id":"1","depth":0}'], over, 1, false, [1]).lines).toEqual(['{"Id":"1","depth":0}']);
    const r = shapeResult(raw('Purchases found:', JSON.stringify(withLines), ...over), call(), 'search_purchases');
    expect(dataOf(r)).toBe(`${LINES(2, 2, 1, 2, 2)}\n{"Id":"1","depth":0}`);
  });

  it('row sizes that do not describe the lines make each line its own row, without throwing', () => {
    const lines = ['a', 'b', 'c'].map((k) => JSON.stringify({ [k]: 'x'.repeat(100) }));
    const L = lines[0].length;
    const ROOM = (n: number) => padding(RESULT_MAX - n);
    // Room for the marker and two lines, less than the three: as three one-line rows, two are kept.
    const room = ROWS(1, 3, 3).length + 2 * (L + 1);
    expect(3 * L + 2).toBeGreaterThan(room);
    for (const sizes of [undefined, [1, 1], [2, 2], [0, 3], [1.5, 1.5], [-1, 4]]) {
      expect(cut('rows', lines, ROOM(room), 1, false, sizes).lines).toEqual([ROWS(1, 3, 3), lines[0], lines[1]]);
    }
    // The same lines as one row of a header and two Lines, or as a row and a row of two: grouped by those sizes.
    expect(cut('rows', lines, ROOM(room), 1, false, [3]).lines).toEqual([LINES(2, 2, 0, 1, 2), lines[0]]);
    expect(cut('rows', lines, ROOM(room), 1, false, [1, 2]).lines).toEqual([ROWS(1, 2, 2), lines[0]]);
  });

  it('shapeResult never throws: each data kind under warnings over 30,000', () => {
    expect(() => shapeResult(raw('Count: 3', ...over), call(), 'search_bills')).not.toThrow();
    expect(dataOf(shapeResult(raw('{"a":1}', ...over), call(), 'get_preferences'))).toBe(OBJECT);
    expect(dataOf(shapeResult(raw('{"Header":{},"Columns":{}}', ...over), call(), 'get_profit_and_loss'))).toBe('{}\n{}');
    expect(dataOf(shapeResult(raw('Found 0 invoices', ...over), call(), 'search_invoices'))).toBe('');
  });
});

describe('T9-3: an own depth key is replaced by the contract depth, written last; rows are grouped by structure', () => {
  const own = (id: string, lines = 0, pad = 0): Record<string, unknown> => {
    const e: Record<string, unknown> = { Id: id, depth: 'own', Memo: 'm'.repeat(pad) };
    if (lines > 0) e.Line = Array.from({ length: lines }, (_, i) => ({ depth: 7, Id: String(i + 1) }));
    return e;
  };

  it('render: an entity, a Line and a report row with their own depth each end with the contract depth', () => {
    expect(render('rows', [own('1', 1), { Id: '2', depth: 3, Line: 'x' }])).toEqual([
      '{"Id":"1","Memo":"","depth":0}',
      '{"Id":"1","depth":1}',
      '{"Id":"2","Line":"x","depth":0}',
    ]);
    const report = { Header: {}, Columns: {}, Rows: { Row: [{ depth: 9, Rows: { Row: [{ depth: 9, ColData: [] }] }, type: 'Section' }] } };
    expect(render('report', report).slice(2)).toEqual(['{"type":"Section","depth":0}', '{"ColData":[],"depth":1}']);
    expect(searchRowSizes([own('1', 2), own('2'), { Id: '3', Line: [5] }])).toEqual([3, 1, 1]);
  });

  it.each([
    ['the first row', 0],
    ['a middle row', 1],
    ['the last row', 2],
  ])('%s with its own depth, under the cut: every row, uncut', (_label, at) => {
    const rows: Record<string, unknown>[] = [{ Id: '1', Line: [{ Id: '1' }] }, { Id: '2' }, { Id: '3', Line: [{ Id: '1' }] }];
    rows[at] = { ...rows[at], depth: 'own' };
    const r = searchOf(rows);
    expect(dataOf(r).split('\n').map((l) => JSON.parse(l).depth)).toEqual([0, 1, 0, 0, 1]);
  });

  it.each([
    ['the first row', 0],
    ['a middle row', 1],
    ['the last row', 2],
  ])('%s with its own depth, over the cut: whole rows by structure, the marker counting three rows', (_label, at) => {
    // Three rows of 12,000 characters with 2 Lines each: two rows fit with the marker, the third doesn't.
    const rows = [entity(1, 12000, 2), entity(2, 12000, 2), entity(3, 12000, 2)];
    rows[at] = { depth: 'own', ...rows[at] };
    const r = searchOf(rows);
    const lines = dataOf(r).split('\n');
    expect(lines[0]).toBe(ROWS(1, 3, 3));
    expect(lines.slice(1)).toEqual(render('rows', rows.slice(0, 2)));
    expect(lines.slice(1).map((l) => JSON.parse(l).depth)).toEqual([0, 1, 1, 0, 1, 1]);
  });

  it('the first row with its own depth over the cut alone: its Lines cut, no throw', () => {
    const rows = [{ depth: 'own', ...entity(1, 20000, 200, 100) }, entity(2, 100)];
    const r = searchOf(rows);
    const first = dataOf(r).split('\n')[0];
    expect(first).toMatch(/^truncated: \d+ of 200 Lines of the first row left out, and 1 of 2 rows\./);
    expect(JSON.parse(dataOf(r).split('\n')[1]).depth).toBe(0);
  });
});
