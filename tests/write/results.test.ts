// Sanctuary Computer (quickbooks-mcp-294): the write results (contract 1.2 §14, spec §6 and §3's 1.0-reason rule): every
// tool-results/qbo_categorize_*/ and qbo_undo_change/ file rendered from its parts and compared whole, A1.10's recorded lines on
// error results, each header key's place, each free text, and 286's results with their trailing status cut.
import { describe, it, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { fakePath } from '../helpers/server.js';
import { errorResult, REASON_TEXT } from '../../src/helpers/tool-result.js';
import * as resultsModule from '../../src/write/results.js';
import { forkReason, freeText, SWITCH_TAIL, withTail, writeError, writeSuccess, type ChangeItem } from '../../src/write/results.js';

type Json = Record<string, any>;
const DIRS = ['qbo_categorize_purchase', 'qbo_categorize_bill', 'qbo_undo_change'];
const result = (rel: string): Json => JSON.parse(readFileSync(fakePath(`tool-results/${rel}`), 'utf8'));
const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const UNDO_KEY = 'quickbooks-write:garden3d:purchase:1001:4:1';
const BILL_KEY = 'quickbooks-write:garden3d:bill:2001:0:1';

const err = (reason: string, kase: string, vars: Record<string, string> = {}, head: Json = {}) => () => writeError(reason, head, freeText(reason, kase, vars));
const LINE_1 = { line_id: '1', before: { account_id: '77', class_id: null }, after: { account_id: '84', class_id: '12' } };
const PURCHASE: ChangeItem = { result: 'sent', company: 'garden3d', type: 'purchase', id: '1001', sync_token: '3', sync_token_after: '4', lines: [LINE_1], undo_of: null, diff: null, writes_off: false };
const ok = (change: Partial<ChangeItem> = {}, head: Json = {}) => () => writeSuccess({ ...PURCHASE, ...change }, { receipt: KEY, ...head });

/** Each fixture from its parts. */
const RENDERED: Record<string, () => unknown> = {
  'qbo_categorize_purchase/account.json': err('write:account', 'type', { id: '40', AccountType: 'Income' }),
  'qbo_categorize_purchase/cap.json': err('write:cap', ''),
  'qbo_categorize_purchase/class.json': err('write:class', 'inactive', { id: '13' }),
  'qbo_categorize_purchase/closed-after-send.json': err('write:closed', 'after-send', {}, { receipt: KEY, code: '6210', intuit_tid: 'fake-tid-0003' }),
  'qbo_categorize_purchase/closed.json': err('write:closed', 'before-send'),
  'qbo_categorize_purchase/diff.json': err('write:diff', ''),
  'qbo_categorize_purchase/disabled.json': err('write:disabled', ''),
  'qbo_categorize_purchase/failed.json': err('write:failed', '', {}, { receipt: KEY, code: '6000', intuit_tid: 'fake-tid-0002' }),
  'qbo_categorize_purchase/line.json': err('write:line', 'not-account', { id: '3' }),
  'qbo_categorize_purchase/noop.json': err('write:noop', ''),
  'qbo_categorize_purchase/not-found.json': err('write:not-found', 'categorize', { T: 'Purchase', id: '1001' }),
  'qbo_categorize_purchase/receipt-failed-appended.json': err('write:receipt-failed', 'intent-key', {}, { receipt: KEY }),
  'qbo_categorize_purchase/receipt-failed.json': err('write:receipt-failed', 'intent'),
  'qbo_categorize_purchase/sent-clear-class.json': ok({ lines: [{ line_id: '2', before: { account_id: '84', class_id: '12' }, after: { account_id: '84', class_id: null } }] }),
  'qbo_categorize_purchase/sent-diff.json': ok({ result: 'sent-diff', diff: ['Line:2', 'TotalAmt'], writes_off: true }),
  'qbo_categorize_purchase/sent-id-mismatch.json': ok({ writes_off: true }, { note: 'id-mismatch' }),
  'qbo_categorize_purchase/sent-ledger-only.json': ok({}, { recorded: 'ledger' }),
  'qbo_categorize_purchase/sent-recorded-none.json': ok({}, { recorded: 'none' }),
  'qbo_categorize_purchase/sent.json': ok(),
  'qbo_categorize_purchase/size.json': err('write:size', ''),
  'qbo_categorize_purchase/stacks-auth.json': () => forkReason({ reason: 'stacks-auth' }),
  'qbo_categorize_purchase/stale.json': err('write:stale', '', {}, { receipt: KEY }),
  'qbo_categorize_purchase/sweep.json': err('write:sweep', ''),
  'qbo_categorize_purchase/type.json': err('write:type', 'credit'),
  'qbo_categorize_purchase/unknown-id-mismatch.json': err('write:unknown', 'id-mismatch', {}, { receipt: KEY, note: 'id-mismatch' }),
  'qbo_categorize_purchase/unknown-recorded-none.json': err('write:unknown', 'recorded-none', {}, { receipt: KEY, recorded: 'none' }),
  'qbo_categorize_purchase/unknown.json': err('write:unknown', 'send', {}, { receipt: KEY }),
  'qbo_categorize_bill/sent.json': () =>
    writeSuccess(
      { ...PURCHASE, type: 'bill', id: '2001', sync_token: '0', sync_token_after: '1', lines: [{ line_id: '1', before: { account_id: '77', class_id: null }, after: { account_id: '91', class_id: null } }] },
      { receipt: BILL_KEY },
    ),
  'qbo_categorize_bill/stacks-bill-intercompany.json': err('write:stacks-bill', 'private-note'),
  'qbo_categorize_bill/stacks-bill.json': err('write:stacks-bill', 'doc-number'),
  'qbo_undo_change/account.json': err('write:account', 'undo', { id: '77' }),
  'qbo_undo_change/changed-since.json': err('write:changed-since', ''),
  'qbo_undo_change/class.json': err('write:class', 'undo', { id: '12' }),
  'qbo_undo_change/closed.json': err('write:closed', 'undo'),
  'qbo_undo_change/not-found.json': err('write:not-found', 'undo', { T: 'Purchase', id: '1001' }),
  'qbo_undo_change/not-sent.json': err('write:not-sent', ''),
  'qbo_undo_change/receipt-failed.json': err('write:receipt-failed', 'lookup'),
  'qbo_undo_change/sent.json': () =>
    writeSuccess(
      { ...PURCHASE, sync_token: '4', sync_token_after: '5', lines: [{ line_id: '1', before: { account_id: '84', class_id: '12' }, after: { account_id: '77', class_id: null } }], undo_of: KEY },
      { receipt: UNDO_KEY },
    ),
  'qbo_undo_change/sweep.json': err('write:sweep', ''),
  'qbo_undo_change/undo-of-undo.json': err('write:undo-of-undo', ''),
  'qbo_undo_change/unknown.json': err('write:unknown', 'undo'),
};

describe('every write tool-results file, rendered from its parts (A3.3\'s render half)', () => {
  it('the list holds every file of the three directories, and no other', () => {
    const files = DIRS.flatMap((dir) => readdirSync(fakePath(`tool-results/${dir}`)).map((name) => `${dir}/${name}`)).sort();
    expect(Object.keys(RENDERED).sort()).toEqual(files);
    expect(files).toHaveLength(41);
  });
  it.each(Object.keys(RENDERED))('%s', (file) => {
    expect(RENDERED[file]()).toEqual(result(file));
  });
});

/** The fixture's first text with `line` put after the header line starting `after`. */
function withLine(file: string, after: string, line: string): Json {
  const fixture = result(file);
  const lines = fixture.content[0].text.split('\n');
  lines.splice(lines.findIndex((l: string) => l.startsWith(`${after}: `)) + 1, 0, line);
  fixture.content[0].text = lines.join('\n');
  return fixture;
}

describe('A1.10: recorded on an error result', () => {
  it('a stale whose outcome reached the ledger only: recorded: ledger after receipt', () => {
    const expected = withLine('qbo_categorize_purchase/stale.json', 'receipt', 'recorded: ledger');
    expect(expected.content[0].text).toBe(`reason: write:stale\nreceipt: ${KEY}\nrecorded: ledger\n\nSomeone edited the transaction meanwhile; nothing was overwritten.`);
    expect(writeError('write:stale', { receipt: KEY, recorded: 'ledger' }, freeText('write:stale', '', {}))).toEqual(expected);
  });
  it('a failed whose outcome wasn\'t confirmed: recorded: none after intuit_tid', () => {
    const expected = withLine('qbo_categorize_purchase/failed.json', 'intuit_tid', 'recorded: none');
    expect(expected.content[0].text).toBe(`reason: write:failed\nreceipt: ${KEY}\ncode: 6000\nintuit_tid: fake-tid-0002\nrecorded: none\n\nQuickBooks refused the change.`);
    expect(writeError('write:failed', { recorded: 'none', intuit_tid: 'fake-tid-0002', code: '6000', receipt: KEY }, freeText('write:failed', '', {}))).toEqual(expected);
  });
});

describe('the header block (§14 Write result grammar)', () => {
  const ALL = { recorded: 'none', note: 'id-mismatch', intuit_tid: 'tid-1', code: '6000', receipt: KEY } as const;
  const textOf = (head: Json, free = 'x') => (writeError('write:unknown', head, free).content[0] as Json).text;

  it('every key, given in reverse, in the grammar\'s order', () => {
    expect(textOf(ALL)).toBe(`reason: write:unknown\nreceipt: ${KEY}\ncode: 6000\nintuit_tid: tid-1\nnote: id-mismatch\nrecorded: none\n\nx`);
  });
  it.each(Object.entries(ALL))('%s alone: reason, then it, then the empty line', (key, value) => {
    expect(textOf({ [key]: value })).toBe(`reason: write:unknown\n${key}: ${value}\n\nx`);
  });
  it('each key left out, the others keep their order', () => {
    const keys = ['receipt', 'code', 'intuit_tid', 'note', 'recorded'] as const;
    for (const out of keys) {
      const head: Json = { ...ALL };
      delete head[out];
      expect(textOf(head)).toBe(['reason: write:unknown', ...keys.filter((k) => k !== out).map((k) => `${k}: ${ALL[k]}`), '', 'x'].join('\n'));
    }
  });
  it('no head: the reason, the empty line, the free text; an empty free text is allowed', () => {
    expect(writeError('write:noop', {}, '')).toEqual({ content: [{ type: 'text', text: 'reason: write:noop\n\n' }], isError: true });
  });
  it('V2: an error never carries writes_off, nor any key outside the grammar', () => {
    const head: Json = { writes_off: true, settled: 'x', result: 'sent', reason: 'write:failed', undefined: 'x', receipt: KEY };
    expect(textOf(head)).toBe(`reason: write:unknown\nreceipt: ${KEY}\n\nx`);
  });
  it('an undefined key is left out', () => {
    expect(textOf({ receipt: KEY, code: undefined })).toBe(`reason: write:unknown\nreceipt: ${KEY}\n\nx`);
  });
  it('intuit_tid has §5\'s form or no line (286\'s rule): `_`, an empty one, 65 characters or a space give none', () => {
    expect(textOf({ intuit_tid: `A-${'b'.repeat(62)}` })).toBe(`reason: write:unknown\nintuit_tid: A-${'b'.repeat(62)}\n\nx`);
    for (const tid of ['a_b', '', 'a'.repeat(65), 'a b', 'a\nb']) expect(textOf({ receipt: KEY, intuit_tid: tid })).toBe(`reason: write:unknown\nreceipt: ${KEY}\n\nx`);
  });
  it('TJ3: an intuit_tid that isn\'t a string (null, a number, an object, true) gives no line and never throws', () => {
    for (const tid of [null, 42, { a: 1 }, true, ['a']]) expect(textOf({ receipt: KEY, intuit_tid: tid })).toBe(`reason: write:unknown\nreceipt: ${KEY}\n\nx`);
  });
  it('TJ4: a code off §14\'s pattern, or a note or recorded outside its values, throws: no wrong header is written', () => {
    for (const code of ['60 00', 'a'.repeat(65), 'é']) expect(() => writeError('write:failed', { code } as any, 'x')).toThrow(TypeError);
    expect(textOf({ code: 'A_b-1' })).toBe('reason: write:unknown\ncode: A_b-1\n\nx');
    for (const note of ['edited-since', 'deleted', 'x']) expect(() => writeError('write:unknown', { note } as any, 'x')).toThrow(TypeError);
    for (const recorded of ['notion', 'x']) expect(() => writeError('write:unknown', { recorded } as any, 'x')).toThrow(TypeError);
    expect(textOf({ note: 'id-mismatch', recorded: 'ledger' })).toBe('reason: write:unknown\nnote: id-mismatch\nrecorded: ledger\n\nx');
  });
  it('a reason or any other key\'s value that isn\'t one non-empty line throws: nothing can add a header line', () => {
    for (const key of ['receipt', 'code', 'note', 'recorded']) {
      for (const bad of ['', 'a\nb', 'a\rb', 5, null]) expect(() => writeError('write:failed', { [key]: bad } as any, 'x')).toThrow(TypeError);
    }
    for (const bad of ['', 'write:failed\nreceipt: x', 'a\rb', 5]) expect(() => writeError(bad as any, {}, 'x')).toThrow(TypeError);
  });
});

describe('T9 TJ6: a header value holds no control character and no line or paragraph separator', () => {
  /** One of each class: C0 (TAB, CR and LF among them), DEL, C1 (U+0085 among them), U+2028, U+2029. */
  const BAD: Array<[string, string]> = [
    ['U+0000', '\u0000'], ['U+0009 (TAB)', '\t'], ['U+000A (LF)', '\n'], ['U+000B', '\u000b'], ['U+000D (CR)', '\r'], ['U+001B', '\u001b'], ['U+001F', '\u001f'],
    ['U+007F', '\u007f'], ['U+0080', '\u0080'], ['U+0085', '\u0085'], ['U+009F', '\u009f'], ['U+2028', '\u2028'], ['U+2029', '\u2029'],
  ];
  it.each(BAD)('%s in a reason, an error\'s receipt or a success\'s receipt throws, at its start, middle or end', (_label, c) => {
    for (const value of [`${c}x`, `write:failed${c}x`, `x${c}`]) {
      expect(() => writeError(value, {}, 'x')).toThrow(TypeError);
      expect(() => writeError('write:failed', { receipt: value }, 'x')).toThrow(TypeError);
      expect(() => writeSuccess(PURCHASE, { receipt: value })).toThrow(TypeError);
    }
  });
  it.each<[string, string]>([['U+0020', ' '], ['U+00A0', '\u00a0'], ['U+00A1', '\u00a1'], ['U+200B', '\u200b'], ['U+2027', '\u2027'], ['U+202A', '\u202a'], ['U+FEFF', '\ufeff']])('%s is no control character: written as given', (_label, c) => {
    const receipt = `${KEY}${c}x`;
    expect((writeError('write:failed', { receipt }, 'x').content[0] as Json).text).toBe(`reason: write:failed\nreceipt: ${receipt}\n\nx`);
    expect(JSON.parse((writeSuccess(PURCHASE, { receipt }).content[0] as Json).text).receipt).toBe(receipt);
  });
});

describe('the change item (§14 Change result)', () => {
  const itemOf = (change: Json, head: Json) => JSON.parse((writeSuccess(change as ChangeItem, head).content[0] as Json).text);
  it('exactly the 13 keys, in the table\'s order, as one compact line, with no isError', () => {
    const out = writeSuccess(PURCHASE, { receipt: KEY });
    expect(Object.keys(out)).toEqual(['content']);
    const { text } = out.content[0] as Json;
    expect(text).not.toContain('\n');
    expect(Object.keys(JSON.parse(text))).toEqual(['result', 'receipt', 'company', 'type', 'id', 'sync_token', 'sync_token_after', 'lines', 'undo_of', 'diff', 'note', 'writes_off', 'recorded']);
  });
  it('receipt, note and recorded come from the head: no note is null, no recorded is notion; code and intuit_tid never show', () => {
    expect(itemOf(PURCHASE, { receipt: KEY, code: '6000', intuit_tid: 'tid-1' })).toMatchObject({ receipt: KEY, note: null, recorded: 'notion' });
    expect(itemOf(PURCHASE, { receipt: UNDO_KEY, note: 'id-mismatch', recorded: 'none' })).toMatchObject({ receipt: UNDO_KEY, note: 'id-mismatch', recorded: 'none' });
  });
  it('TJ4: an undefined or mistyped undo_of, diff or writes_off, or a note or recorded outside its values, throws', () => {
    const bad: Json[] = [{ undo_of: undefined }, { undo_of: 5 }, { diff: undefined }, { diff: 'Line' }, { diff: [1] }, { writes_off: undefined }, { writes_off: 'true' }];
    for (const over of bad) expect(() => writeSuccess({ ...PURCHASE, ...over } as ChangeItem, { receipt: KEY })).toThrow(TypeError);
    for (const head of [{ note: 'x' }, { note: 'deleted' }, { recorded: 'x' }]) expect(() => writeSuccess(PURCHASE, { receipt: KEY, ...head } as any)).toThrow(TypeError);
    expect(itemOf({ ...PURCHASE, undo_of: KEY, diff: ['Line:1'] }, { receipt: KEY, recorded: 'notion' })).toMatchObject({ undo_of: KEY, diff: ['Line:1'], recorded: 'notion' });
  });
  it('a success with no receipt, or one that isn\'t a line, throws', () => {
    for (const head of [{}, { receipt: '' }, { receipt: `${KEY}\nx` }]) expect(() => writeSuccess(PURCHASE, head)).toThrow(TypeError);
  });
  it('keys outside the table, on the change or a line, are not written; a line\'s refs are written in their order', () => {
    const line = { extra: 1, after: { class_id: '12', account_id: '84', x: 1 }, before: { class_id: null, account_id: '77' }, line_id: '1' };
    const change = { extra: 1, receipt: 'other', note: 'other', recorded: 'other', ...PURCHASE, lines: [line] };
    expect(writeSuccess(change, { receipt: KEY })).toEqual(result('qbo_categorize_purchase/sent.json'));
  });
});

// Spec §6, by reason and case; `<T>`, `<id>` and `<AccountType>` filled from the vars.
const VARS = { T: 'Bill', id: '42', AccountType: 'Bank' };
const TABLE: Array<[string, string, string]> = [
  ['write:size', '', 'At most 20 lines can be changed in one call.'],
  ['write:sweep', '', 'The job guard hasn\'t run clean in the last 20 minutes; writes are held.'],
  ['write:disabled', '', 'Writes are switched off.'],
  ['write:not-found', 'categorize', 'QuickBooks has no Bill 42.'],
  ['write:not-found', 'undo', 'QuickBooks has no Bill 42 any more.'],
  ['write:type', 'credit', 'The transaction is a credit card credit, which can\'t be recategorized.'],
  ['write:type', 'entity', 'QuickBooks answered with another kind of transaction than a Bill.'],
  ['write:stacks-bill', 'doc-number', 'Stacks made this bill (DocNumber Stacks_…); Stacks would undo the change.'],
  ['write:stacks-bill', 'private-note', 'This is an intercompany bill Stacks made.'],
  ['write:closed', 'before-send', 'The books are closed for this transaction\'s date.'],
  ['write:closed', 'unreadable', 'The company\'s close date can\'t be read.'],
  ['write:closed', 'undo', 'The books have since closed for this transaction\'s date.'],
  ['write:closed', 'after-send', 'QuickBooks says the books are closed.'],
  ['write:line', 'not-account', 'Line 42 isn\'t an account-based expense line.'],
  ['write:line', 'missing', 'Line 42 isn\'t on this transaction.'],
  ['write:line', 'twice', 'Line 42 is named twice.'],
  ['write:line', 'ids', 'A line of this transaction has no Id or shares one, so it can\'t be re-sent safely.'],
  ['write:account', 'type', 'Account 42 is an Bank account; choose an Expense, Other Expense or Cost of Goods Sold account.'],
  ['write:account', 'missing', 'Account 42 doesn\'t exist.'],
  ['write:account', 'inactive', 'Account 42 is inactive.'],
  ['write:account', 'undo', 'Account 42 no longer exists.'],
  ['write:class', 'inactive', 'Class 42 is inactive.'],
  ['write:class', 'missing', 'Class 42 doesn\'t exist.'],
  ['write:class', 'undo', 'Class 42 no longer exists.'],
  ['write:noop', '', 'No named line would change.'],
  ['write:diff', '', 'The built request differs from the transaction outside the named lines; nothing was sent.'],
  ['write:cap', '', 'The daily limit of changes for this company is reached.'],
  ['write:receipt-failed', 'intent', 'The write receipt couldn\'t be recorded; nothing was sent.'],
  ['write:receipt-failed', 'intent-key', 'Notion refused the intent receipt; nothing was sent.'],
  ['write:receipt-failed', 'lookup', 'The write ledger couldn\'t be read; nothing was sent.'],
  ['write:receipt-failed', 'settle', 'The settled outcome couldn\'t be recorded; nothing was sent.'],
  ['write:stale', '', 'Someone edited the transaction meanwhile; nothing was overwritten.'],
  ['write:failed', '', 'QuickBooks refused the change.'],
  ['write:unknown', 'send', 'QuickBooks didn\'t answer; the change will be settled by a later check.'],
  ['write:unknown', 'recorded-none', 'No answer, and the outcome wasn\'t confirmed recorded.'],
  ['write:unknown', 'id-mismatch', 'QuickBooks answered with another transaction\'s id; writes are switched off.'],
  ['write:unknown', 'undo', 'That change\'s result isn\'t settled yet; try again in a few minutes.'],
  ['write:changed-since', '', 'Someone changed these lines since; nothing was sent.'],
  ['write:not-sent', '', 'That change was never sent.'],
  ['write:undo-of-undo', '', 'That receipt is itself an undo; categorize again instead.'],
  ['fork-error', '', 'The server failed before it could read QuickBooks.'],
];

describe('freeText (spec §6)', () => {
  it.each(TABLE)('%s %j', (reason, kase, text) => {
    expect(freeText(reason, kase, VARS)).toBe(text);
  });
  it('the refused registration\'s fork-error text is 286\'s', () => {
    expect(freeText('fork-error', '', {})).toBe(REASON_TEXT['fork-error']);
  });
  it('a case is its reason\'s alone: a reason with one text takes no case, and one with cases takes no empty one', () => {
    expect(() => freeText('write:size', 'credit', {})).toThrow(new TypeError('results: no free text for write:size credit'));
    expect(() => freeText('write:type', '', {})).toThrow(new TypeError('results: no free text for write:type '));
    expect(() => freeText('write:closed', 'credit', {})).toThrow(new TypeError('results: no free text for write:closed credit'));
  });
  it.each([['write:other', ''], ['stacks-auth', ''], ['toString', ''], ['__proto__', ''], ['constructor', ''], ['constructor', 'constructor'], ['write:size', 'toString'], ['write:size', 'constructor'], ['write:line', '__proto__'], ['write:line', 'constructor'], ['write:line', 'toString'], ['constructor', 'name'], ['constructor', 'length'], ['toString', 'name'], ['write:size', 'hasOwnProperty'], ['hasOwnProperty', 'name']])('%s %j has no text: it throws, naming the reason and case (TJ1, TK3)', (reason, kase) => {
    // The exact error: a table with a prototype answers some of these with a string (constructor name: "Object") and throws another
    // TypeError for others (a function's .replace), so only this message decides that the tables have no prototype.
    expect(() => freeText(reason, kase, VARS)).toThrow(new TypeError(`results: no free text for ${reason} ${kase}`));
  });
  it('a var the text needs that is missing or isn\'t a string throws; one it doesn\'t need is ignored', () => {
    expect(() => freeText('write:line', 'twice', {})).toThrow(TypeError);
    expect(() => freeText('write:line', 'twice', { id: 42 } as any)).toThrow(TypeError);
    expect(() => freeText('write:account', 'type', { id: '40' })).toThrow(TypeError);
    expect(() => freeText('write:not-found', 'undo', { id: '1' })).toThrow(TypeError);
    expect(freeText('write:noop', '', { id: '1' })).toBe('No named line would change.');
  });
  it('a var is put in as it is, once, never read as a pattern', () => {
    expect(freeText('write:account', 'type', { id: '$&', AccountType: '<id> $1 $$' })).toBe('Account $& is an <id> $1 $$ account; choose an Expense, Other Expense or Cost of Goods Sold account.');
  });
});

describe('forkReason: 286\'s result, its trailing (<3 digits>) cut (spec §3)', () => {
  const textOf = (f: Json) => (forkReason(f as any).content[0] as Json).text;
  it.each([
    ['stacks-auth', 'Stacks refused the server\'s key.'],
    ['not-connected', 'This company has no QuickBooks connection in Stacks.'],
    ['unknown-enterprise', 'Stacks doesn\'t know this company\'s key.'],
    ['renewal-failed:unavailable', 'Stacks couldn\'t renew the QuickBooks sign-in; Intuit gave no code.'],
    ['renewal-failed:invalid_grant', 'Stacks couldn\'t renew the QuickBooks sign-in; Intuit answered invalid_grant.'],
  ])('%s', (reason, text) => {
    expect(forkReason({ reason })).toEqual({ content: [{ type: 'text', text: `reason: ${reason}\n\n${text}` }], isError: true });
  });
  it('every other 1.0 text and header as 286\'s', () => {
    for (const f of [
      { reason: 'fork-error' },
      { reason: 'timeout', intuitTid: 'tid-9' },
      { reason: 'http-500', intuitTid: 'tid-9' },
      { reason: 'stacks-unreachable' },
      { reason: 'name-mismatch', source: 'quickbooks', reported: 'Other Co' },
      { reason: 'not-a-reason' },
    ] as Json[]) {
      expect(forkReason(f as any)).toEqual(errorOf(f));
    }
    expect(textOf({ reason: 'http-500', intuitTid: 'tid-9' })).toBe('reason: http-500\nintuit_tid: tid-9\n\nQuickBooks answered 500.');
  });
  it('only the four reasons are cut: each of them, with any text ending " (ddd)."', () => {
    for (const reason of ['stacks-auth', 'not-connected', 'unknown-enterprise', 'renewal-failed:unavailable', 'renewal-failed:invalid_grant', 'renewal-failed:x']) {
      expect(textOf({ reason, text: 'x (500).' })).toBe(`reason: ${reason}\n\nx.`);
    }
  });
  it('every other 1.0 reason keeps its text whole even when it ends " (500)", a QuickBooks fault text included', () => {
    const fault = 'QuickBooks answered 400. QuickBooks said: m: d (500).';
    for (const f of [
      { reason: 'fork-error', text: 'x (500).' },
      { reason: 'http-400', intuitTid: 'tid-9', text: fault },
      { reason: 'timeout', text: 'x (500)' },
      { reason: 'stacks-unreachable', text: 'x (500).' },
      { reason: 'name-mismatch', source: 'stacks', reported: 'Other Co', text: 'x (500).' },
    ] as Json[]) {
      expect(forkReason(f as any)).toEqual(errorOf(f));
      expect(textOf(f)).toMatch(/ \(500\)\.?$/);
    }
    // A reason that only starts like one of the four is another reason.
    expect(textOf({ reason: 'stacks-authx', text: 'x (500).' })).toBe(`reason: fork-error\n\n${REASON_TEXT['fork-error']}`);
  });
  it('the cut is exactly a space, three digits in parentheses, then the end or a last full stop', () => {
    const cut = (t: string) => textOf({ reason: 'stacks-auth', text: t }).slice('reason: stacks-auth\n\n'.length);
    expect([cut('x (403).'), cut('x (403)'), cut('x (403) (404).'), cut('(1) (999).')]).toEqual(['x.', 'x', 'x (403).', '(1).']);
    for (const kept of ['x (4033).', 'x (40).', 'x(403).', 'x  (40).', 'x (403) .', 'x (403)..', 'x (403).y', 'x (40a).', 'x [403].', 'x (403);', 'x (403).\n', 'a (403) b.', 'x (٣٠٣).', 'x\t(403).']) {
      expect([kept, cut(kept)]).toEqual([kept, kept]);
    }
  });
  it('the result has its one item and isError, as 286\'s', () => {
    expect(Object.keys(forkReason({ reason: 'stacks-auth' })).sort()).toEqual(['content', 'isError']);
    expect(forkReason({ reason: 'stacks-auth' }).content).toHaveLength(1);
  });
});

const errorOf = (f: Json) => errorResult(f as any, []);

it('results.ts exports exactly these', () => {
  expect(Object.keys(resultsModule).sort()).toEqual(['SWITCH_TAIL', 'forkReason', 'freeText', 'withTail', 'writeError', 'writeSuccess']);
});

describe('task-9-1 TR1, TR5: the settle sentences, and a result that ends with one', () => {
  it('SWITCH_TAIL: deleted is §6’s write:disabled text; stuck tells the reader to delete the file; frozen', () => {
    expect({ ...SWITCH_TAIL }).toEqual({ deleted: 'Writes are switched off.', stuck: "The switch file couldn't be deleted; delete it by hand." });
    expect(SWITCH_TAIL.deleted).toBe(freeText('write:disabled', '', {}));
    expect(Object.isFrozen(SWITCH_TAIL)).toBe(true);
  });
  it('an error: its one text item gains the sentence after a space, isError kept', () => {
    const e = writeError('write:stale', { receipt: KEY }, freeText('write:stale', '', {}));
    expect(withTail(e, 'X y.')).toEqual({ content: [{ type: 'text', text: `${(e.content[0] as { text: string }).text} X y.` }], isError: true });
  });
  it('a success: a WARNING: item after the data item, the data item unchanged and no isError', () => {
    const r = ok()();
    expect(withTail(r, 'X y.')).toEqual({ content: [...r.content, { type: 'text', text: 'WARNING: X y.' }] });
  });
});
