// Sanctuary Computer (quickbooks-mcp-293): the pre-send check (A2.1-A2.16), through the real guard, interceptors and call store, with
// write mode's rules, against the stub network over the socket trap, on 297's transactions/ (tests/fakes/transactions).
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { createHash } from 'crypto';
import { trapNetwork } from '../fakes/no-network.js';
import { installStubNetwork, type StubAnswer, type StubCall } from '../fakes/stub-network.js';
import { stacksFake, type StacksFakeOpts } from '../fakes/stacks-token.js';
import { fixtureToken, NOW, QBO_HOST, REALMS, testEnv } from '../helpers/server.js';
import { guardedAxios, secureStart } from '../../src/http-guard.js';
import { clearFailure, currentCall, recordFailure, runInCall, setCallToken, type CallStore } from '../../src/clients/call-context.js';
import { loadConfig } from '../../src/clients/config.js';
import { createRuntime, type Runtime } from '../../src/clients/runtime.js';
import { MINOR_VERSION } from '../../src/write/client.js';
import { compare } from '../../src/write/compare.js';
import { decideWrite } from '../../src/write/guard-rules.js';
import * as preSendModule from '../../src/write/pre-send.js';
import { isChecked, preSend, ruleClosed, ruleLines, ruleStacksBill, ruleSubjectLine, ruleType } from '../../src/write/pre-send.js';
import { buildBody, checkBody, ruleNoop } from '../../src/write/rules.js';
import { StubRegistry } from './stub-registry.js';
import { asInput, byId, changesOf, entityOf, fixture, sharedId, withLines, withoutId, type Json } from './derive.js';

const COMPANY = 'garden3d';
const TID = 'tid-293';

const trap = trapNetwork();
let stacksOpts: StacksFakeOpts = {};
let stacks = stacksFake();
/** What QuickBooks holds, by path (`purchase/1001`): a body (200), an answer, or a thrown error. */
let books: Record<string, Json | Answered | Error> = {};
/** Run as each request arrives, before it is answered. */
let onRequest: (path: string) => void = () => undefined;
type Answered = { answer: StubAnswer };
const answered = (status: number, body: unknown, headers: Record<string, string> = {}): Answered => ({
  answer: { status, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { intuit_tid: TID, 'Retry-After': '0', ...headers } },
});
const net = installStubNetwork((call) => (call.hostname === QBO_HOST ? qbo(call) : stacks.handler(call)));
const ax = guardedAxios();

const pathOf = (call: StubCall): string => /^\/v3\/company\/[0-9]+\/(.*)\?minorversion=75$/.exec(call.path!)![1];
function qbo(call: StubCall): StubAnswer {
  const path = pathOf(call);
  onRequest(path);
  const held = books[path];
  if (held instanceof Error) throw held;
  if (held === undefined) return MISSING().answer;
  return 'answer' in held ? (held as Answered).answer : answered(200, held).answer;
}
const MISSING = () => answered(400, fixture('faults/get-missing.json'));
const fault = (code: unknown) => ({ Fault: { Error: [{ Message: 'm', Detail: 'd', code }], type: 'ValidationFault' } });

let guarded: unknown[] = [];
/** A path write mode's rules refuse. */
let refusing = '';
let runtime: Runtime;
let restoreStart: () => void;
beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stacksOpts = {};
  stacks = stacksFake(stacksOpts);
  onRequest = () => undefined;
  guarded = [];
  refusing = '';
  const registry = new StubRegistry();
  const extraRules = {
    decide(request: any, context: any) {
      guarded.push(request.url);
      if (refusing !== '' && request.url.includes(refusing)) return { allow: false, rule: 'guard-error' } as const;
      return decideWrite(request, context, { company: () => currentCall()?.company, registry });
    },
  };
  restoreStart = secureStart(testEnv() as NodeJS.ProcessEnv, [], { extraRules });
  runtime = createRuntime(loadConfig(testEnv()), { now: () => NOW });
  resetBooks();
});
afterEach(() => {
  runtime.close();
  restoreStart();
  jest.restoreAllMocks();
  expect(trap.reached).toEqual([]);
});
afterAll(() => {
  net.restore();
  trap.restore();
});

/** Every account and class, the preferences with a close date, and each fetched transaction as its first state; `fetched` files replace. */
function resetBooks(...fetched: string[]): void {
  books = { preferences: fixture('preferences/book-close-date.json') };
  for (const [id, body] of byId('accounts')) books[`account/${id}`] = body;
  for (const [id, body] of byId('classes')) books[`class/${id}`] = body;
  for (const file of ['bill-2001', 'bill-2002-stacks', 'bill-2003-intercompany', 'purchase-1001', 'purchase-1002-credit', 'purchase-1003-item-line', 'purchase-1004-on-close-date'].map((f) => `fetched/${f}.json`).concat(fetched)) {
    const body = fixture(file);
    books[`${body.Purchase ? 'purchase' : 'bill'}/${entityOf(body).Id}`] = body;
  }
  net.calls.length = 0;
}
const gets = (): string[] => net.calls.filter((c) => c.hostname === QBO_HOST).map(pathOf);

/** Runs `fn` as a tool call that holds its company's fake token. */
const inCall = <T>(fn: (call: CallStore) => Promise<T>, company = COMPANY): Promise<T> =>
  runInCall(company, () => {
    setCallToken(fixtureToken(company), REALMS[company]);
    return fn(currentCall()!);
  });
type Ran = { out: Json; failure: CallStore['failure'] };
const ask = (input: Json, deps?: Json): Promise<Ran> => inCall(async (call) => ({ out: await (preSend as any)(input, deps), failure: call.failure }));
const allowed = async (input: Json, deps?: Json): Promise<Json> => {
  const { out } = await ask(input, deps);
  expect(out).toMatchObject({ ok: true });
  return out.checked;
};
/** Refused with exactly this, no `checked`, these GETs and none after. */
async function refused(input: Json, refusal: Json | string, expected: string[], deps?: Json): Promise<Ran> {
  net.calls.length = 0;
  const ran = await ask(input, deps);
  expect(ran.out).toEqual(typeof refusal === 'string' ? { ok: false, reason: refusal } : { ok: false, ...refusal });
  await new Promise((resolve) => setImmediate(resolve));
  expect(gets()).toEqual(expected);
  // A rule's refusal leaves no failure of an earlier answer; nothing but GETs ever leaves.
  if (String(ran.out.reason).startsWith('write:')) expect(ran.failure).toBeNull();
  expect(net.calls.filter((c) => c.hostname === QBO_HOST && c.method !== 'GET')).toEqual([]);
  return ran;
}

/** A write refusal: its reason and its detail (spec §3 "gap: free texts", §6), as preSend and the pure rules answer it. */
const R = (reason: string, detail: Json = {}): Json => ({ reason, detail });

// 297's allowed calls.
const P = () => asInput('account-and-class').input; // Purchase 1001, line 1 to account 84 and class 12
const B = () => asInput('account-change').input; // Bill 2001, line 1 to account 91
const DRY = (from: Json = P()): Json => ({ company: from.company, entity: from.entity, id: from.id, mode: 'dry' });
const UNDO = (from: Json = P()): Json => ({ ...from, mode: 'undo' });
const P_READS = ['purchase/1001', 'preferences'];
const B_READS = ['bill/2001', 'preferences'];
const purchase = (): Json => (books['purchase/1001'] as Json).Purchase;
const bill = (): Json => (books['bill/2001'] as Json).Bill;
const prefs = (): Json => (books.preferences as Json).Preferences.AccountingInfoPrefs;
const account = (id: string): Json => (books[`account/${id}`] as Json).Account;
const cls = (id: string): Json => (books[`class/${id}`] as Json).Class;

type Row = { name: string; base?: () => Json; edit?: () => void; input?: Json; refusal: string | Json; gets: string[]; modes?: string[]; pure?: (answer: Json, input: Json) => unknown };
/** The unchanged call is allowed first (A2.10), then the one change refuses it. */
async function oneChange({ base = P, edit, input, refusal, gets: expected, pure }: Row): Promise<void> {
  resetBooks();
  const call = base();
  await allowed(call);
  const served = (): Json => JSON.parse(JSON.stringify(books[`${call.entity}/${call.id}`]));
  if (pure) expect(pure(served(), call)).toBeNull();
  edit?.();
  const changed = { ...call, ...input };
  await refused(changed, refusal, expected);
  if (pure) expect(pure(JSON.parse(JSON.stringify(books[`${changed.entity}/${changed.id}`])), changed)).toEqual(refusal);
}

describe('A2.1: the fetches', () => {
  it('each once, in the contract\'s order, with the one minor version and the call\'s token, through the guard', async () => {
    await allowed(P());
    expect(gets()).toEqual([...P_READS, 'account/84', 'class/12']);
    const root = `https://${QBO_HOST}/v3/company/${REALMS[COMPANY]}`;
    expect(guarded).toEqual([...P_READS, 'account/84', 'class/12'].map((path) => `${root}/${path}?minorversion=${MINOR_VERSION}`));
    for (const call of net.calls) expect(call.headers).toMatchObject({ Authorization: `Bearer ${fixtureToken(COMPANY)}` });
  });

  it('nothing is cached, and a second call reads again', async () => {
    await allowed(B());
    await allowed(B());
    expect(gets()).toEqual([...B_READS, 'account/91', ...B_READS, 'account/91']);
  });

  it('each distinct account and class once, in the order named', async () => {
    withLines(books['purchase/1001'] as Json, 4);
    const lines = [
      { line_id: '4', account_id: '91', class_id: '13' },
      { line_id: '1', account_id: '84', class_id: '12' },
      { line_id: '3', account_id: '91', class_id: '13' },
      { line_id: '2', account_id: '84', class_id: null },
    ];
    for (const mode of ['categorize', 'undo']) {
      net.calls.length = 0;
      await allowed({ ...P(), mode, lines });
      expect(gets()).toEqual([...P_READS, 'account/91', 'account/84', 'class/13', 'class/12']);
    }
  });

  it('a write fetch with minorversion 74 is refused by the guard (A2.16)', async () => {
    const url = `https://${QBO_HOST}/v3/company/${REALMS[COMPANY]}/purchase/1001?minorversion=74`;
    await inCall(() => expect(ax.get(url)).rejects.toMatchObject({ name: 'GuardRefusedError' }));
    expect(net.calls).toEqual([]);
  });

  it('for the call\'s company only: each company\'s overlapping check goes to its own realm with its own token', async () => {
    const names = [COMPANY, 'index-space'];
    await Promise.all(names.map((company) => inCall(() => preSend({ ...B(), company } as any), company)));
    for (const name of names) {
      const own = net.calls.filter((c) => c.headers?.Authorization === `Bearer ${fixtureToken(name)}`);
      expect(own.map((c) => c.path)).toEqual([...B_READS, 'account/91'].map((path) => `/v3/company/${REALMS[name]}/${path}?minorversion=75`));
    }
  });
});

// A2.2-A2.4: every mode keeps these.
const typeOf = (answer: Json, input: Json) => ruleType(input.entity, answer);
const stacksBillOf = (answer: Json, input: Json) => ruleStacksBill(input.entity, entityOf(answer));
const closedOf = (answer: Json, input: Json) => ruleClosed(entityOf(answer), prefs(), input.mode === 'undo');
const linesOf = (answer: Json, input: Json) => ruleLines(entityOf(answer), input.lines);
const closeDate = (value: unknown) => () => {
  prefs().BookCloseDate = value;
};
const HEADER_ROWS: Row[] = [
  { name: 'type: a purchase answered with a Bill', edit: () => (books['purchase/1001'] = fixture('fetched/bill-2001.json')), refusal: R('write:type', { case: 'entity', T: 'Purchase' }), gets: P_READS, pure: typeOf },
  { name: 'type: a bill answered with a Purchase', base: B, edit: () => (books['bill/2001'] = fixture('fetched/purchase-1001.json')), refusal: R('write:type', { case: 'entity', T: 'Bill' }), gets: B_READS, pure: typeOf },
  { name: 'type: a purchase answered with a Vendor', edit: () => (books['purchase/1001'] = { Vendor: { Id: '1001' } }), refusal: R('write:type', { case: 'entity', T: 'Purchase' }), gets: P_READS, pure: typeOf },
  { name: 'type: a second entity beside the asked one', edit: () => ((books['purchase/1001'] as Json).Bill = bill()), refusal: R('write:type', { case: 'entity', T: 'Purchase' }), gets: P_READS, pure: typeOf },
  { name: 'type: a Credit purchase', edit: () => (purchase().Credit = true), refusal: R('write:type', { case: 'credit' }), gets: P_READS, pure: typeOf },
  { name: 'stacks-bill: DocNumber', base: B, edit: () => (bill().DocNumber = 'Stacks_'), refusal: R('write:stacks-bill', { case: 'doc-number' }), gets: B_READS, pure: stacksBillOf },
  { name: 'stacks-bill: PrivateNote', base: B, edit: () => (bill().PrivateNote = 'garden3d invoice 0001'), refusal: R('write:stacks-bill', { case: 'private-note' }), gets: B_READS, pure: stacksBillOf },
  { name: 'closed: on the close date', edit: closeDate('2026-11-10'), refusal: R('write:closed', { case: 'before-send' }), gets: P_READS, pure: closedOf },
  { name: 'closed: before the close date', edit: closeDate('2026-12-01'), refusal: R('write:closed', { case: 'before-send' }), gets: P_READS, pure: closedOf },
  ...[null, '', '2026-02-30', '2026-13-01', '2026-00-10', '2026/01/31', '2026-01-31 ', 'x2026-01-31', '2026-1-31', '2026-01-31T00:00:00', '2026-01-31T', '+012026-01-31', '-002026-01-31', 20260131, ['2026-01-31'], {}, false].map(
    (value): Row => ({ name: `closed: a close date of ${JSON.stringify(value)}`, edit: closeDate(value), refusal: R('write:closed', { case: 'unreadable' }), gets: P_READS, pure: closedOf }),
  ),
  ...['', '2026/11/10', '2026-11-31', '9999'].map((value): Row => ({ name: `closed: a TxnDate of ${JSON.stringify(value)}`, edit: () => (purchase().TxnDate = value), refusal: R('write:closed', { case: 'before-send' }), gets: P_READS, pure: closedOf })),
];
describe.each(['categorize', 'undo', 'dry'])('A2.2-A2.4 in %s', (mode) => {
  const as = (base: () => Json) => () => (mode === 'dry' ? DRY(base()) : { ...base(), mode });
  // Undo's closed is its own case (§6: "have since closed"); every other detail is the same in each mode.
  const inMode = (refusal: Json): Json => (mode === 'undo' && refusal.detail.case === 'before-send' ? R(refusal.reason, { case: 'undo' }) : refusal);
  it.each(HEADER_ROWS)('$name', (row) => oneChange({ ...row, base: as(row.base ?? P), refusal: inMode(row.refusal as Json) }));

  it.each<[string, () => Json, () => void]>([
    ['Credit false', P, () => (purchase().Credit = false)],
    ['a Bill with Credit true', B, () => (bill().Credit = true)],
    ['DocNumber in another case', B, () => (bill().DocNumber = 'stacks_1')],
    ['DocNumber holding the prefix later', B, () => (bill().DocNumber = ' Stacks_1')],
    ['DocNumber without the underscore', B, () => (bill().DocNumber = 'Stacks1')],
    ['PrivateNote with a leading space', B, () => (bill().PrivateNote = ' garden3d invoice')],
    ['PrivateNote in another case', B, () => (bill().PrivateNote = 'Garden3d invoice')],
    ['DocNumber and PrivateNote that are no strings', B, () => Object.assign(bill(), { DocNumber: ['Stacks_'], PrivateNote: 5 })],
    ['a Purchase with both prefixes', P, () => Object.assign(purchase(), { DocNumber: 'Stacks_1', PrivateNote: 'garden3d invoice' })],
    ['a close date the day before', P, closeDate('2026-11-09')],
    ['a leap day as close date', P, closeDate('2024-02-29')],
    ['no close date', P, () => (books.preferences = fixture('preferences/no-book-close-date.json'))],
    ['no close date and a TxnDate that is no date', P, () => ((books.preferences = fixture('preferences/no-book-close-date.json')), (purchase().TxnDate = 'x'))],
    ['no time key', P, () => delete (books['purchase/1001'] as Json).time],
  ])('passes: %s', async (_name, base, edit) => {
    edit();
    await allowed(as(base)());
    const call = base();
    const answer = JSON.parse(JSON.stringify(books[`${call.entity}/${call.id}`]));
    expect([typeOf(answer, call), stacksBillOf(answer, call), closedOf(answer, call), closedOf(answer, { mode: 'undo' })]).toEqual([null, null, null, null]);
  });
});

describe('297\'s refused transactions', () => {
  it.each<[string, string, string, Json]>([
    ['purchase', '1002', 'write:type', { case: 'credit' }],
    ['bill', '2002', 'write:stacks-bill', { case: 'doc-number' }],
    ['bill', '2003', 'write:stacks-bill', { case: 'private-note' }],
    ['purchase', '1004', 'write:closed', { case: 'before-send' }],
    ['purchase', '1003', 'write:line', { case: 'not-account', id: '1' }],
  ])('%s %s: %s %j', (entity, id, reason, detail) => refused({ ...P(), entity, id }, R(reason, detail), [`${entity}/${id}`, 'preferences']));
});

const PASSES = () => Promise.resolve(null);
const LINE_ROWS: Row[] = [
  { name: 'a named line that is missing', input: { lines: [{ line_id: '9', account_id: '84', class_id: '12' }] }, refusal: R('write:line', { case: 'missing', id: '9' }), gets: P_READS, pure: linesOf },
  { name: 'an item-based named line', edit: () => (purchase().Line[0].DetailType = 'ItemBasedExpenseLineDetail'), refusal: R('write:line', { case: 'not-account', id: '1' }), gets: P_READS, pure: linesOf },
  { name: 'a line named twice', input: { lines: [...P().lines, { line_id: '1', account_id: '91' }] }, refusal: R('write:line', { case: 'twice', id: '1' }), gets: P_READS, pure: linesOf },
  { name: 'no line named', input: { lines: [] }, refusal: R('write:line', { case: 'none' }), gets: P_READS, pure: linesOf },
  { name: 'a named line beside one that is missing', input: { lines: [...P().lines, { line_id: '9', account_id: '84' }] }, refusal: R('write:line', { case: 'missing', id: '9' }), gets: P_READS, pure: linesOf },
];
// Every mode keeps these, on a line no one names.
const ID_ROWS: Array<[string, () => void]> = [
  ['no Id', () => withoutId(books['purchase/1001'] as Json)],
  ['a shared Id', () => sharedId(books['purchase/1001'] as Json)],
  ['an empty Id', () => (purchase().Line[1].Id = '')],
  ['a number Id', () => (purchase().Line[1].Id = 2)],
  ['a null Id', () => (purchase().Line[1].Id = null)],
  ['no object', () => (purchase().Line[1] = null)],
  ['an array', () => (purchase().Line[1] = [])],
  ['a word', () => (purchase().Line[1] = 'x')],
];
describe('A2.5: line', () => {
  it.each(LINE_ROWS)('$name', (row) => oneChange(row));
  it.each(ID_ROWS)('a fetched line with %s, in every mode', async (_name, edit) => {
    const ids = R('write:line', { case: 'ids' });
    await oneChange({ name: '', edit, refusal: ids, gets: P_READS, pure: linesOf });
    await oneChange({ name: '', base: UNDO, edit, refusal: ids, gets: P_READS });
    await oneChange({ name: '', base: DRY, edit, refusal: ids, gets: P_READS, pure: (answer) => ruleSubjectLine(entityOf(answer)) });
  });

  it('a transaction whose lines are all gone, in every mode', async () => {
    purchase().Line = [];
    await refused(P(), R('write:line', { case: 'missing', id: '1' }), P_READS);
    await refused(DRY(), R('write:line', { case: 'subject' }), P_READS);
    await refused(UNDO(), R('write:diff'), [...P_READS, 'account/84', 'class/12']);
  });

  it('undo: no line named', () => oneChange({ name: '', base: UNDO, input: { lines: [] }, refusal: R('write:line', { case: 'none' }), gets: P_READS }));

  it('undo: a line named twice, one that is missing, or one that is item-based is refused by the body check, never allowed', async () => {
    const reads = [...P_READS, 'account/84', 'class/12'];
    await refused({ ...UNDO(), lines: [...P().lines, ...P().lines] }, R('write:diff'), reads);
    await refused({ ...UNDO(), lines: [...P().lines, { line_id: '9', account_id: '84' }] }, R('write:diff'), reads);
    purchase().Line[0].DetailType = 'ItemBasedExpenseLineDetail';
    await refused(UNDO(), R('write:diff'), reads);
  });

  it('a named line that says it is account-based and holds no such detail', async () => {
    for (const detail of [undefined, null, 'x', []]) {
      purchase().Line[0].AccountBasedExpenseLineDetail = detail;
      for (const input of [P(), UNDO()]) await refused(input, R('write:diff'), [...P_READS, 'account/84', 'class/12']);
    }
  });

  it('dry (E3): no account-based line, and the rules on a transaction with no lines at all', async () => {
    purchase().Line.forEach((line: Json) => (line.DetailType = 'ItemBasedExpenseLineDetail'));
    await refused(DRY(), R('write:line', { case: 'subject' }), P_READS);
    expect(ruleSubjectLine(purchase())).toEqual(R('write:line', { case: 'subject' }));
    expect([ruleSubjectLine({}), ruleLines({}, P().lines)]).toEqual([R('write:line', { case: 'subject' }), R('write:line', { case: 'missing', id: '1' })]);
    purchase().Line[1].DetailType = 'AccountBasedExpenseLineDetail';
    expect(ruleSubjectLine(purchase())).toBeNull();
    net.calls.length = 0;
    await allowed(DRY());
    // The item-based line's account is not one to read.
    expect(gets()).toEqual([...P_READS, 'account/84', 'class/12']);
  });

  it('a line id is whatever non-empty string QuickBooks gave, on a line no one names', async () => {
    purchase().Line[1].Id = 'x';
    await allowed(P());
  });
});

describe('A2.6: account', () => {
  const READS = [...P_READS, 'account/84'];
  const to = (account_id: string): Json => ({ lines: [{ ...P().lines[0], account_id }] });
  it('missing, by either 610', async () => {
    const missing = R('write:account', { case: 'missing', id: '84' });
    await oneChange({ name: '', edit: () => delete books['account/84'], refusal: missing, gets: READS });
    await oneChange({ name: '', edit: () => (books['account/84'] = answered(200, fixture('faults/get-deleted.json'))), refusal: missing, gets: READS });
  });
  it('inactive', () => oneChange({ name: '', edit: () => (account('84').Active = false), refusal: R('write:account', { case: 'inactive', id: '84' }), gets: READS }));
  it('297\'s inactive account', () => oneChange({ name: '', input: to('86'), refusal: R('write:account', { case: 'inactive', id: '86' }), gets: [...P_READS, 'account/86'] }));
  const all = [...byId('accounts').values()].map(entityOf);
  const TYPES = ['Expense', 'Other Expense', 'Cost of Goods Sold'];
  const refusedTypes = all.filter((a) => !TYPES.includes(a.AccountType));
  it('297 holds 13 refused types and an active account of each allowed one', () => {
    expect(new Set(refusedTypes.map((a) => a.AccountType)).size).toBe(13);
    expect(new Set(all.filter((a) => a.Active && TYPES.includes(a.AccountType)).map((a) => a.AccountType)).size).toBe(3);
  });
  it.each(refusedTypes.map((a) => [a.AccountType, a.Id]))('refused type %s', (type, id) => oneChange({ name: '', input: to(id), refusal: R('write:account', { case: 'type', id, AccountType: type }), gets: [...P_READS, `account/${id}`] }));
  // T9 TJ6: the type is matched as read and written cleaned by §5's name rule; a type cleaned to nothing reads `untyped`.
  it.each([['expense', 'expense'], ['Expense ', 'Expense'], ['Other Expenses', 'Other Expenses'], ['', 'untyped']])('a type close to an allowed one: %j, written %j', (type, shown) => oneChange({ name: '', edit: () => (account('84').AccountType = type), refusal: R('write:account', { case: 'type', id: '84', AccountType: shown }), gets: READS }));
  const CLASSES: Array<[string, string]> = [
    ['U+0000', '\u0000'], ['U+0009 (TAB)', '\t'], ['U+000A (LF)', '\n'], ['U+000D (CR)', '\r'], ['U+001F', '\u001f'],
    ['U+007F', '\u007f'], ['U+0080', '\u0080'], ['U+0085', '\u0085'], ['U+009F', '\u009f'], ['U+2028', '\u2028'], ['U+2029', '\u2029'],
  ];
  it.each(CLASSES)('T9 TJ6: %s in a refused type becomes a space, and the ends are trimmed', async (_label, c) => {
    for (const [type, shown] of [[`Bank${c}x`, 'Bank x'], [`${c}Bank${c}`, 'Bank'], [`Expense${c}`, 'Expense'], [c, 'untyped'], [`${c} ${c}`, 'untyped']]) {
      await oneChange({ name: '', edit: () => (account('84').AccountType = type), refusal: R('write:account', { case: 'type', id: '84', AccountType: shown }), gets: READS });
    }
  });
  it.each<[string, string, string]>([
    ['kept to its first 200 code points, then its end trimmed', `${'x'.repeat(199)} ${'y'.repeat(50)}`, 'x'.repeat(199)],
    ['200 code points, not code units', '\u{1F600}'.repeat(201), '\u{1F600}'.repeat(200)],
    ['a character that is no control kept inside (U+00A0, U+200B)', 'Bank\u00a0x\u200by', 'Bank\u00a0x\u200by'],
  ])('T9 TJ6: a refused type %s', (_label, type, shown) => oneChange({ name: '', edit: () => (account('84').AccountType = type), refusal: R('write:account', { case: 'type', id: '84', AccountType: shown }), gets: READS }));
  it.each(['84', '91', '92'])('account %s passes', async (id) => {
    await allowed({ ...P(), ...to(id) });
  });
  it('each distinct account is checked: the second one refuses', async () => {
    const lines = [...P().lines, { line_id: '2', account_id: '31' }];
    await refused({ ...P(), lines }, R('write:account', { case: 'type', id: '31', AccountType: 'Bank' }), [...READS, 'account/31']);
  });
});

describe('A2.7: class', () => {
  const READS = [...P_READS, 'account/84', 'class/12'];
  it('missing, by either 610', async () => {
    const missing = R('write:class', { case: 'missing', id: '12' });
    await oneChange({ name: '', edit: () => delete books['class/12'], refusal: missing, gets: READS });
    await oneChange({ name: '', edit: () => (books['class/12'] = answered(404, fixture('faults/get-deleted.json'))), refusal: missing, gets: READS });
  });
  it('inactive', () => oneChange({ name: '', edit: () => (cls('12').Active = false), refusal: R('write:class', { case: 'inactive', id: '12' }), gets: READS }));
  it('297\'s inactive class, named second', () =>
    oneChange({ name: '', input: { lines: [...P().lines, { line_id: '2', account_id: '84', class_id: '19' }] }, refusal: R('write:class', { case: 'inactive', id: '19' }), gets: [...READS, 'class/19'] }));
  it('an omitted or null class makes no class GET and passes', async () => {
    for (const name of ['account-keeps-class', 'class-cleared', 'account-change']) {
      net.calls.length = 0;
      await allowed(asInput(name).input);
      expect(gets().filter((path) => path.startsWith('class/'))).toEqual([]);
      expect(gets()).toHaveLength(3);
    }
  });
});

describe('A2.8: noop', () => {
  const two = (...lines: Json[]): Json => ({ ...P(), lines });
  const SAME = { line_id: '2', account_id: '84', class_id: '12' };
  it.each<[string, Json[], string[]]>([
    ['the same account and class', [SAME], ['account/84', 'class/12']],
    ['the same account, class omitted', [{ line_id: '2', account_id: '84' }], ['account/84']],
    ['the same account, class cleared where there is none', [{ line_id: '1', account_id: '77', class_id: null }], ['account/77']],
    ['class omitted where there is none', [{ line_id: '1', account_id: '77' }], ['account/77']],
    ['both lines unchanged', [SAME, { line_id: '1', account_id: '77', class_id: null }], ['account/84', 'account/77', 'class/12']],
  ])('%s', async (_name, lines, reads) => {
    await allowed(P());
    await refused(two(...lines), R('write:noop'), [...P_READS, ...reads]);
    // Undo and the write check's dry run skip it (A2.13).
    await allowed({ ...two(...lines), mode: 'undo' });
  });
  it.each<[string, Json[]]>([
    ['one of two accounts', [SAME, { line_id: '1', account_id: '84' }]],
    ['one of two accounts, named first', [{ line_id: '1', account_id: '84' }, SAME]],
    ['a class alone', [{ line_id: '2', account_id: '84', class_id: '13' }]],
    ['a class cleared', [{ line_id: '2', account_id: '84', class_id: null }]],
    ['a class set where there is none', [{ line_id: '1', account_id: '77', class_id: '12' }]],
  ])('passes: %s', async (_name, lines) => {
    await allowed(two(...lines));
  });
  it('a ClassRef with no value is some class, and a missing AccountRef no account: clearing one or setting the other is a change', () => {
    const line = (detail: Json) => ({ Line: [{ Id: '1', DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: detail }] });
    expect(ruleNoop(line({ AccountRef: { value: '77' }, ClassRef: { name: 'x' } }), [{ line_id: '1', account_id: '77', class_id: null }])).toBeNull();
    expect(ruleNoop(line({ AccountRef: { value: '77' }, ClassRef: { value: null } }), [{ line_id: '1', account_id: '77', class_id: null }])).toBeNull();
    expect(ruleNoop(line({}), [{ line_id: '1', account_id: '77' }])).toBeNull();
    expect(ruleNoop(line({ AccountRef: { value: '77', name: 'x' } }), [{ line_id: '1', account_id: '77', class_id: null }])).toEqual(R('write:noop'));
  });
});

describe('A2.9: size', () => {
  it('20 lines pass; 21 are refused with nothing fetched', async () => {
    withLines(books['purchase/1001'] as Json, 21);
    await allowed({ ...P(), lines: changesOf(20) });
    await refused({ ...P(), lines: changesOf(21) }, R('write:size'), []);
  });
  it('is categorize\'s alone: an undo of 21 lines passes (E2)', async () => {
    withLines(books['purchase/1001'] as Json, 21);
    await allowed({ ...UNDO(), lines: changesOf(21) });
  });
  it('is first: it wins over a line named twice, a malformed line, another company and the hook (E1)', async () => {
    const beforeFetch = jest.fn(() => Promise.resolve('write:sweep'));
    await refused({ ...P(), lines: Array(21).fill(changesOf(1)[0]), beforeFetch }, R('write:size'), []);
    await refused({ ...P(), lines: Array(21).fill(null) }, R('write:size'), []);
    await refused({ ...P(), lines: changesOf(21), company: 'index-space' }, R('write:size'), []);
    expect(beforeFetch).not.toHaveBeenCalled();
  });
});

describe('the order (contract §15, §18), each pair by a call that fails both', () => {
  const stacksBill = () => (bill().DocNumber = 'Stacks_1');
  const lateClose = closeDate('2026-12-31');
  const badIds = () => withoutId(books['bill/2001'] as Json);
  type Pair = [name: string, edit: () => void, input: Json, reason: string | Json, gets: string[]];
  const pairs: Pair[] = [
    ['size before everything: 21 lines on a Stacks bill', stacksBill, { ...B(), lines: changesOf(21) }, R('write:size'), []],
    ['not-found before preferences', () => ((books['bill/2001'] = MISSING()), (books.preferences = answered(500, {}))), B(), R('write:not-found', { case: 'categorize', T: 'Bill', id: '2001' }), ['bill/2001']],
    ['preferences before type', () => ((books['purchase/1001'] as Json).Purchase.Credit = true, (books.preferences = {})), P(), 'fork-error', P_READS],
    ['type before line: a Credit purchase with a line named twice', () => (purchase().Credit = true), { ...P(), lines: [...P().lines, ...P().lines] }, R('write:type', { case: 'credit' }), P_READS],
    ['type before stacks-bill', () => ((books['bill/2001'] as Json).Purchase = {}, stacksBill()), B(), R('write:type', { case: 'entity', T: 'Bill' }), B_READS],
    ['type before closed', () => (lateClose(), (purchase().Credit = true)), P(), R('write:type', { case: 'credit' }), P_READS],
    ['stacks-bill before closed', () => (lateClose(), stacksBill()), B(), R('write:stacks-bill', { case: 'doc-number' }), B_READS],
    ['closed before line', () => (lateClose(), badIds()), B(), R('write:closed', { case: 'before-send' }), B_READS],
    ['line before account', () => (badIds(), delete books['account/91']), B(), R('write:line', { case: 'ids' }), B_READS],
    ['account before class', () => (delete books['account/84'], delete books['class/12']), P(), R('write:account', { case: 'missing', id: '84' }), [...P_READS, 'account/84']],
    ['class before noop', () => (cls('12').Active = false), { ...P(), lines: [{ line_id: '2', account_id: '84', class_id: '12' }] }, R('write:class', { case: 'inactive', id: '12' }), [...P_READS, 'account/84', 'class/12']],
    ['account before noop', () => (account('84').Active = false), { ...P(), lines: [{ line_id: '2', account_id: '84' }] }, R('write:account', { case: 'inactive', id: '84' }), [...P_READS, 'account/84']],
    ['undo: closed before line', () => (lateClose(), badIds()), UNDO(B()), R('write:closed', { case: 'undo' }), B_READS],
    ['undo: line before account', () => (badIds(), delete books['account/91']), UNDO(B()), R('write:line', { case: 'ids' }), B_READS],
    ['dry: closed before line', () => (lateClose(), badIds()), DRY(B()), R('write:closed', { case: 'before-send' }), B_READS],
    ['dry: line before account', () => (badIds(), delete books['account/77']), DRY(B()), R('write:line', { case: 'ids' }), B_READS],
  ];
  it.each(pairs)('%s', async (_name, edit, input, reason, expected) => {
    edit();
    await refused(input, reason, expected);
  });
  it('noop before diff, and every rule before the body is built', async () => {
    const build = jest.fn(() => ({}));
    await refused({ ...P(), lines: [{ line_id: '2', account_id: '84' }] }, R('write:noop'), [...P_READS, 'account/84'], { buildBody: build });
    expect(build).not.toHaveBeenCalled();
    await refused(P(), R('write:diff'), [...P_READS, 'account/84', 'class/12'], { buildBody: build });
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe('A2.11: the body', () => {
  it.each(['account-and-class', 'account-change', 'account-keeps-class', 'class-change', 'class-cleared', 'undo', 'undo-to-asset'])('297\'s %s', async (name) => {
    const { input, fetched, expected } = asInput(name);
    resetBooks(fetched);
    const checked = await allowed(input);
    expect(checked.body).toEqual(expected.sparse_body);
    expect(checked.bodyText).toBe(JSON.stringify(expected.sparse_body));
    expect(createHash('sha256').update(checked.bodyText).digest('hex')).toBe(expected.sparse_body_sha256);
    expect(checked).toMatchObject({ company: COMPANY, entity: input.entity, mode: input.mode, changes: input.lines, fetched: entityOf(fixture(fetched)) });
    expect(Object.keys(checked).sort()).toEqual(['body', 'bodyText', 'changes', 'checkedAt', 'company', 'entity', 'fetched', 'mode', 'names']);
    expect(isChecked(checked)).toBe(true);
    expect(compare(checked.body, checked.fetched, checked.changes)).toEqual({ same: true });
  });

  it('dry: the transaction as fetched, no change, each account and class of it read once', async () => {
    const checked = await allowed(DRY());
    const { MetaData: _m, ...rest } = fixture('fetched/purchase-1001.json').Purchase;
    expect(checked).toMatchObject({ mode: 'dry', changes: [], body: { ...rest, sparse: true } });
    expect(gets()).toEqual([...P_READS, 'account/77', 'account/84', 'class/12']);
  });

  it('a cleared class leaves no ClassRef key; a fetched sparse is replaced; own keys of any name and numbers are copied', async () => {
    Object.assign(purchase(), { sparse: false, '7': 1, Amount: 1.1e-7 });
    const raw = JSON.stringify(books['purchase/1001']).replace('"PaymentType"', '"__proto__":{"x":1},"PaymentType"');
    books['purchase/1001'] = answered(200, raw);
    for (const input of [asInput('class-cleared').input, UNDO(asInput('class-cleared').input), DRY()]) {
      const checked = await allowed(input);
      expect(checked.body.sparse).toBe(true);
      expect(Object.keys(checked.body)).toEqual(expect.arrayContaining(['__proto__', '7', 'Amount']));
      expect(checked.bodyText).toContain('"__proto__":{"x":1}');
      expect(JSON.stringify(checked.body)).toBe(checked.bodyText);
      if (input.mode !== 'dry') expect(Object.keys(checked.body.Line[1].AccountBasedExpenseLineDetail)).toEqual(['AccountRef']);
    }
  });

  it('a kept class keeps its whole ClassRef; a replaced ref sends no name; the rest of the detail stays', async () => {
    const detail = purchase().Line[1].AccountBasedExpenseLineDetail;
    Object.assign(detail, { AccountRef: { value: '84', name: 'Software' }, ClassRef: { value: '12', name: 'Client' }, BillableStatus: 'NotBillable' });
    const lineOf = async (change: Json) => (await allowed({ ...P(), lines: [{ line_id: '2', account_id: '91', ...change }] })).body.Line[1].AccountBasedExpenseLineDetail;
    expect(await lineOf({})).toEqual({ AccountRef: { value: '91' }, ClassRef: { value: '12', name: 'Client' }, BillableStatus: 'NotBillable' });
    expect(await lineOf({ class_id: '13' })).toEqual({ AccountRef: { value: '91' }, ClassRef: { value: '13' }, BillableStatus: 'NotBillable' });
    expect(await lineOf({ class_id: undefined })).toMatchObject({ ClassRef: { value: '12', name: 'Client' } });
  });
});

// A2.12. Each edit is one difference from the body `buildBody` makes; purchase 1001, line 1 or 2 named.
type Edit = { name: string; lines?: Json[]; edit: (body: Json, mode: string) => unknown };
const D = (line: Json): Json => line.AccountBasedExpenseLineDetail;
const CLEAR_2 = [{ line_id: '2', account_id: '84', class_id: null }];
const KEEP_2 = [{ line_id: '2', account_id: '91' }];
const SET_2 = [{ line_id: '2', account_id: '91', class_id: '13' }];
const EDITS: Edit[] = [
  { name: '(a) an unnamed line\'s Amount', edit: (b) => (b.Line[1].Amount = 21) },
  { name: '(b) a named line\'s Amount', edit: (b) => (b.Line[0].Amount = 101) },
  { name: '(c) a named line\'s Description', edit: (b) => (b.Line[0].Description = 'x') },
  { name: '(d) a named line\'s DetailType', edit: (b) => (b.Line[0].DetailType = 'ItemBasedExpenseLineDetail') },
  { name: '(e) an unnamed line\'s AccountRef', edit: (b) => (D(b.Line[1]).AccountRef = { value: '91' }) },
  { name: '(f) another account than asked', edit: (b) => (D(b.Line[0]).AccountRef = { value: '91' }) },
  { name: '(g) a ClassRef on a cleared line', lines: CLEAR_2, edit: (b, mode) => (D(b.Line[1]).ClassRef = { value: mode === 'dry' ? '13' : '12' }) },
  { name: '(h) a ClassRef changed where class_id is omitted', lines: KEEP_2, edit: (b) => (D(b.Line[1]).ClassRef = { value: '13' }) },
  { name: '(h) a ClassRef dropped where class_id is omitted', lines: KEEP_2, edit: (b) => delete D(b.Line[1]).ClassRef },
  { name: '(h) a ClassRef added where class_id is omitted', lines: [{ line_id: '1', account_id: '84' }], edit: (b) => (D(b.Line[0]).ClassRef = { value: '12' }) },
  { name: '(i) a dropped last line', edit: (b) => b.Line.pop() },
  { name: '(i) a dropped named line', edit: (b) => b.Line.shift() },
  { name: '(j) an added line', edit: (b) => b.Line.push({ ...b.Line[1], Id: '3' }) },
  { name: '(k) two lines swapped', edit: (b) => b.Line.reverse() },
  { name: '(l) a named line\'s Id', edit: (b) => (b.Line[0].Id = '3') },
  { name: '(l) an unnamed line\'s Id', edit: (b) => (b.Line[1].Id = '3') },
  { name: '(m) the Id', edit: (b) => (b.Id = '1002') },
  { name: '(n) the SyncToken', edit: (b) => (b.SyncToken = '4') },
  { name: '(o) PaymentType', edit: (b) => (b.PaymentType = 'Cash') },
  { name: '(o) TxnDate', edit: (b) => (b.TxnDate = '2026-11-11') },
  { name: '(p) an added key', edit: (b) => (b.PrivateNote = 'x') },
  { name: '(q) a header field left out', edit: (b) => delete b.TotalAmt },
  { name: '(r) another class than asked', lines: SET_2, edit: (b) => (D(b.Line[1]).ClassRef = { value: '14' }) },
  { name: 'a named line\'s class left out', lines: SET_2, edit: (b) => delete D(b.Line[1]).ClassRef },
  { name: 'a null ClassRef on a cleared line', lines: CLEAR_2, edit: (b) => (D(b.Line[1]).ClassRef = null) },
  { name: 'a name in a named AccountRef', edit: (b) => (D(b.Line[0]).AccountRef.name = 'x') },
  { name: 'a named AccountRef left out', edit: (b) => delete D(b.Line[0]).AccountRef },
  { name: 'a number for a named account', edit: (b) => (D(b.Line[0]).AccountRef.value = Number(D(b.Line[0]).AccountRef.value)) },
  { name: 'a name in a named ClassRef', lines: SET_2, edit: (b) => (D(b.Line[1]).ClassRef.name = 'x') },
  { name: 'a detail field added', edit: (b) => (D(b.Line[0]).BillableStatus = 'Billable') },
  { name: 'a named line\'s detail left out', edit: (b) => delete b.Line[0].AccountBasedExpenseLineDetail },
  { name: 'a named line\'s detail as an array', edit: (b) => (b.Line[0].AccountBasedExpenseLineDetail = []) },
  { name: 'a named line that is null', edit: (b) => (b.Line[0] = null) },
  { name: 'an unnamed line\'s ClassRef left out', edit: (b) => delete D(b.Line[1]).ClassRef },
  { name: 'a field set to undefined', edit: (b) => (b.DocNumber = undefined, b.TotalAmt = undefined) },
  { name: 'MetaData kept', edit: (b) => (b.MetaData = { CreateTime: '2026-11-10T09:00:00-08:00' }) },
  { name: 'no sparse', edit: (b) => delete b.sparse },
  { name: 'sparse false', edit: (b) => (b.sparse = false) },
  { name: 'sparse "true"', edit: (b) => (b.sparse = 'true') },
  { name: 'no Line', edit: (b) => delete b.Line },
  { name: 'Line as an object', edit: (b) => (b.Line = { ...b.Line, length: 2 }) },
  { name: 'an amount as a string', edit: (b) => (b.TotalAmt = '120') },
  { name: 'an own __proto__ key', edit: (b) => Object.defineProperty(b, '__proto__', { value: {}, enumerable: true }) },
  { name: 'a toJSON that answers another body', edit: (b) => (b.toJSON = () => ({ ...b, toJSON: undefined, TotalAmt: 1 })) },
  { name: 'a getter that changes as it is read', edit: (b) => Object.defineProperty(b, 'TotalAmt', { enumerable: true, get: () => 1 }) },
];
const A12_LETTERS = [...new Set(EDITS.map((e) => /^\((.)\)/.exec(e.name)?.[1]).filter(Boolean))].join('');
describe('A2.12: write:diff', () => {
  it('holds a case for each of the 18', () => expect(A12_LETTERS).toBe('abcdefghijklmnopqr'));

  describe.each(['categorize', 'undo', 'dry'])('in %s', (mode) => {
    const inputOf = (lines: Json[] = P().lines): Json => (mode === 'dry' ? DRY() : { ...P(), mode, lines });
    it.each(EDITS)('$name', async ({ lines, edit }) => {
      const input = inputOf(lines);
      const before = await allowed(input, { buildBody });
      expect(isChecked(before)).toBe(true);
      const expected = gets();
      const bad = (fetched: any, changes: any) => {
        const body = JSON.parse(JSON.stringify(buildBody(fetched, changes)));
        edit(body, mode);
        return body;
      };
      await refused(input, R('write:diff'), expected, { buildBody: bad });
    });

    it.each([undefined, null, [], 'x', 5, true, () => ({})])('a body that is %p', async (body) => {
      const input = inputOf();
      await allowed(input);
      const expected = gets();
      await refused(input, R('write:diff'), expected, { buildBody: () => body });
    });

    it('a body that can\'t be written, or a builder that throws, is fork-error', async () => {
      const input = inputOf();
      const cycle: Json = {};
      cycle.self = cycle;
      await allowed(input);
      const expected = gets();
      await refused(input, 'fork-error', expected, { buildBody: () => cycle });
      await refused(input, 'fork-error', expected, { buildBody: () => { throw new Error('x'); } });
      // It is handed frozen things only.
      await refused(input, 'fork-error', expected, { buildBody: (fetched: any) => { fetched.TotalAmt = 1; } });
      await refused(input, 'fork-error', expected, { buildBody: (fetched: any) => { fetched.Line[0].Amount = 1; } });
    });
  });

  it('the text that is sent is what is compared: a number JSON can\'t write', async () => {
    books['purchase/1001'] = answered(200, JSON.stringify(books['purchase/1001']).replace('"TotalAmt":120', '"TotalAmt":1e999'));
    await refused(P(), R('write:diff'), [...P_READS, 'account/84', 'class/12']);
  });

  it.each<[string, (list: any[]) => unknown]>([
    ['dropped', (list) => list.pop()],
    ['added', (list) => list.push({ TxnId: '3' })],
    ['changed', (list) => (list[1].TxnId = '3')],
    ['reordered', (list) => list.reverse()],
  ])('an item of a header list %s', async (_name, edit) => {
    purchase().LinkedTxn = [{ TxnId: '1' }, { TxnId: '2' }];
    await allowed(P());
    const bad = (fetched: any, changes: any) => {
      const body = JSON.parse(JSON.stringify(buildBody(fetched, changes)));
      edit(body.LinkedTxn);
      return body;
    };
    await refused(P(), R('write:diff'), [...P_READS, 'account/84', 'class/12'], { buildBody: bad });
  });

  it('every change is made, on its own line', () => {
    const txn = purchase();
    const change = P().lines[0];
    const text = JSON.stringify(buildBody(txn, [change]));
    expect(checkBody(txn, text, [change])).toEqual(JSON.parse(text));
    expect(checkBody(txn, text, [])).toBeNull();
    expect(checkBody(txn, text, [change, { ...change }])).toBeNull();
    expect(checkBody(txn, text, [change, { line_id: '9', account_id: '84' }])).toBeNull();
    const { Line: _line, ...noLine } = txn;
    expect(checkBody(noLine, JSON.stringify(buildBody(noLine, [])), [])).toBeNull();
    const { MetaData: _m, ...plain } = noLine;
    expect(checkBody(plain, JSON.stringify({ ...plain, sparse: true }), [])).toBeNull();
    const bare = { ...txn, Line: [null] };
    expect(checkBody(bare, JSON.stringify(buildBody(bare, [])), [])).not.toBeNull();
    expect(checkBody({ ...txn, N: Number('-0') }, JSON.stringify(buildBody({ ...txn, N: Number('-0') }, [])), [])).not.toBeNull();
  });
});

describe('A2.13: modes', () => {
  it('undo passes a before account of another type, an inactive one and an inactive class, all refused in categorize', async () => {
    for (const change of [{ account_id: '30' }, { account_id: '86' }, { account_id: '84', class_id: '19' }]) {
      const lines = [{ line_id: '1', ...change }];
      await allowed({ ...UNDO(), lines });
      const { out } = await ask({ ...P(), lines });
      expect(out.reason).toBe('class_id' in change ? 'write:class' : 'write:account');
    }
  });
  it('undo refuses a before account or class answered 610', async () => {
    await oneChange({ name: '', base: UNDO, edit: () => delete books['account/84'], refusal: R('write:account', { case: 'undo', id: '84' }), gets: [...P_READS, 'account/84'] });
    await oneChange({ name: '', base: UNDO, edit: () => delete books['class/12'], refusal: R('write:class', { case: 'undo', id: '12' }), gets: [...P_READS, 'account/84', 'class/12'] });
  });
  it('undo and dry need neither Active nor AccountType in the answer', async () => {
    for (const key of ['account/84', 'account/77', 'class/12']) entityOf(books[key] as Json).Active = undefined;
    for (const id of ['84', '77']) delete account(id).AccountType;
    await allowed(UNDO());
    await allowed(DRY());
  });
  it('dry (E3) refuses an account or class answered 610 on a line no one names', async () => {
    const reads = [...P_READS, 'account/77'];
    await oneChange({ name: '', base: DRY, edit: () => delete books['account/77'], refusal: R('write:account', { case: 'undo', id: '77' }), gets: reads });
    await oneChange({ name: '', base: DRY, edit: () => delete books['account/84'], refusal: R('write:account', { case: 'undo', id: '84' }), gets: [...reads, 'account/84'] });
    await oneChange({ name: '', base: DRY, edit: () => delete books['class/12'], refusal: R('write:class', { case: 'undo', id: '12' }), gets: [...reads, 'account/84', 'class/12'] });
  });
  it('dry passes an account of another type and an inactive class, and an unchanged request categorize refuses', async () => {
    const [one, two] = purchase().Line.map(D);
    one.AccountRef.value = '31';
    two.ClassRef.value = '19';
    await allowed(DRY());
  });
  it('dry: an account-based line whose account or class can\'t be read is fork-error, and the guard is not asked for it', async () => {
    const bad: Array<() => unknown> = [
      () => delete D(purchase().Line[0]).AccountRef,
      () => (D(purchase().Line[0]).AccountRef = {}),
      () => (D(purchase().Line[0]).AccountRef.value = 77),
      () => (D(purchase().Line[0]).AccountRef.value = '7x'),
      () => delete purchase().Line[0].AccountBasedExpenseLineDetail,
    ];
    for (const edit of bad) {
      resetBooks();
      edit();
      guarded = [];
      await refused(DRY(), 'fork-error', P_READS);
      expect(guarded).toHaveLength(2);
    }
    for (const ref of [null, {}, { value: null }, { value: 12 }]) {
      resetBooks();
      D(purchase().Line[1]).ClassRef = ref;
      guarded = [];
      await refused(DRY(), 'fork-error', [...P_READS, 'account/77', 'account/84']);
      expect(guarded).toHaveLength(4);
    }
  });
  it('dry takes no lines', async () => {
    for (const lines of [P().lines, [], null, changesOf(21)]) await refused({ ...DRY(), lines }, 'fork-error', []);
    await refused({ ...DRY(), mode: 'send' }, 'fork-error', []);
    await allowed({ ...DRY(), lines: undefined });
  });
  it('checked.mode is the mode it ran in (SB5)', async () => {
    for (const input of [P(), UNDO(), DRY()]) expect((await allowed(input)).mode).toBe(input.mode);
  });
});

describe('the hooks (E1, E2)', () => {
  const inputs = (): Json[] => [P(), UNDO(), DRY()];
  it('beforeFetch runs once, before the first GET, in every mode; a reason refuses and nothing is fetched', async () => {
    for (const input of inputs()) {
      const seen: number[] = [];
      net.calls.length = 0;
      await allowed({ ...input, beforeFetch: () => (seen.push(gets().length), PASSES()) });
      expect(seen).toEqual([0]);
      await refused({ ...input, beforeFetch: () => Promise.resolve('write:sweep') }, R('write:sweep'), []);
    }
  });
  it('beforeFetch is not asked for a call that is not this one\'s', async () => {
    const beforeFetch = jest.fn(PASSES);
    await refused({ ...P(), company: 'index-space', beforeFetch }, 'fork-error', []);
    expect(beforeFetch).not.toHaveBeenCalled();
  });
  it('afterLine runs once, after line and before account, in every mode, with the fetched transaction', async () => {
    for (const input of inputs()) {
      const seen: unknown[] = [];
      net.calls.length = 0;
      await allowed({ ...input, afterLine: (fetched: unknown) => (seen.push([fetched, gets()]), null) });
      expect(seen).toEqual([[fixture('fetched/purchase-1001.json').Purchase, P_READS]]);
      delete books['account/84'];
      delete books['account/77'];
      await refused({ ...input, afterLine: () => 'write:changed-since' }, R('write:changed-since'), P_READS);
      withoutId(books['purchase/1001'] as Json);
      const afterLine = jest.fn(() => 'write:changed-since');
      await refused({ ...input, afterLine }, R('write:line', { case: 'ids' }), P_READS);
      expect(afterLine).not.toHaveBeenCalled();
      resetBooks();
    }
  });
  it('undo: a named line that is missing reaches afterLine, which may refuse it; a null answer still gives no checked', async () => {
    const lines = [{ line_id: '9', account_id: '84' }];
    await refused({ ...UNDO(), lines, afterLine: () => 'write:changed-since' }, R('write:changed-since'), P_READS);
    const afterLine = jest.fn(() => null);
    await refused({ ...UNDO(), lines, afterLine }, R('write:diff'), [...P_READS, 'account/84']);
    expect(afterLine).toHaveBeenCalledTimes(1);
  });
  it('a hook that throws, or answers neither null nor a reason, is fork-error and nothing more is sent', async () => {
    const thrown = () => { throw new Error('x'); };
    for (const beforeFetch of [thrown, () => Promise.reject(new Error('x')), () => Promise.resolve(undefined), () => Promise.resolve(''), () => Promise.resolve(true), 'x', null]) {
      await refused({ ...P(), beforeFetch }, 'fork-error', []);
    }
    for (const afterLine of [thrown, () => undefined, () => '', () => false, () => Promise.resolve(null), 'x', null]) {
      for (const input of inputs()) await refused({ ...input, afterLine }, 'fork-error', P_READS);
    }
  });
  it('a promise from afterLine is fork-error, whatever it comes to, with no unhandled rejection (TF4)', async () => {
    for (const input of inputs()) {
      await refused({ ...input, afterLine: async () => { throw new Error('x'); } }, 'fork-error', P_READS);
      for (const promise of [Promise.reject(new Error('x')), Promise.resolve(null), Promise.resolve('write:sweep')]) {
        const then = jest.spyOn(promise, 'then');
        await refused({ ...input, afterLine: () => promise }, 'fork-error', P_READS);
        expect(then.mock.calls.map(([, onRejected]) => typeof onRejected)).toEqual(['function']);
        await promise.catch(() => undefined);
      }
      const throwing = jest.fn(() => { throw new Error('x'); });
      await refused({ ...input, afterLine: () => ({ then: throwing }) }, 'fork-error', P_READS);
      expect(throwing).toHaveBeenCalledTimes(1);
      await refused({ ...input, afterLine: () => Object.defineProperty({}, 'then', { get: throwing }) }, 'fork-error', P_READS);
      expect(throwing).toHaveBeenCalledTimes(2);
    }
  });
});

describe('A2.15: a failed or unexpected read', () => {
  type Broken = { name: string; path: string; answer: () => Json | Answered | Error; refusal: string | Json; failure?: 'stands' };
  const HTTP = (status: number, text?: string): Json => ({ reason: `http-${status}`, intuitTid: TID, ...(text === undefined ? {} : { text }) });
  const SAID = 'QuickBooks answered 400. QuickBooks said: m: d';
  /** Reads no rule can use, on any of the four. */
  const ANY = (path: string): Broken[] => [
    { name: 'a 500', path, answer: () => answered(500, {}), refusal: HTTP(500), failure: 'stands' },
    { name: 'a 403', path, answer: () => answered(403, '<html>'), refusal: HTTP(403), failure: 'stands' },
    { name: 'a 429 twice', path, answer: () => answered(429, {}), refusal: HTTP(429), failure: 'stands' },
    { name: 'a 400 Fault of another code', path, answer: () => answered(400, fault('6000')), refusal: HTTP(400, SAID), failure: 'stands' },
    { name: 'a 400 Fault whose code is the number 610', path, answer: () => answered(400, fault(610)), refusal: HTTP(400, SAID), failure: 'stands' },
    { name: 'a 400 with 610 in the text only', path, answer: () => answered(400, { Fault: { Error: [{ Message: '610', Detail: 'Object Not Found', code: '500' }] } }), refusal: { reason: 'http-400' }, failure: 'stands' },
    { name: 'a 400 whose second error is 610', path, answer: () => answered(400, { Fault: { Error: [...fault('6000').Fault.Error, ...fault('610').Fault.Error] } }), refusal: HTTP(400, SAID), failure: 'stands' },
    { name: 'a 400 with a code 610 outside a Fault', path, answer: () => answered(400, { code: '610', Error: [{ code: '610' }] }), refusal: HTTP(400), failure: 'stands' },
    { name: 'a 610 as the HTTP status', path, answer: () => answered(610, {}), refusal: HTTP(610), failure: 'stands' },
    { name: 'a 404 with no Fault', path, answer: () => answered(404, {}), refusal: HTTP(404), failure: 'stands' },
    { name: 'a redirect', path, answer: () => answered(302, {}, { location: 'https://evil.example.test/' }), refusal: HTTP(302), failure: 'stands' },
    { name: 'a reset', path, answer: () => Object.assign(new Error('reset'), { code: 'ECONNRESET' }), refusal: 'fork-error', failure: 'stands' },
    { name: 'a 200 Fault of another code', path, answer: () => fault('6000'), refusal: 'fork-error' },
    { name: 'a 200 Fault beside the asked object', path, answer: () => ({ ...(books[path] as Json), Fault: null }), refusal: 'fork-error' },
    ...['{}', '[]', 'null', '"x"', '5', '', 'not json', '{"time":"x"}'].map((body): Broken => ({ name: `a 200 of ${JSON.stringify(body)}`, path, answer: () => answered(200, body), refusal: 'fork-error' })),
    { name: 'a 199 with the asked object', path, answer: () => answered(199, books[path]), refusal: HTTP(199), failure: 'stands' },
    { name: 'a 204', path, answer: () => answered(204, ''), refusal: 'fork-error' },
  ];
  const ALL = [...P_READS, 'account/84', 'class/12'];
  const inner = (path: string, key: string, edit: (found: Json) => unknown) => () => {
    const answer = JSON.parse(JSON.stringify(books[path]));
    edit(answer[key]);
    return answer;
  };
  const without = (path: string, key: string, name: string): Broken => ({ name: `no ${name}`, path, answer: inner(path, key, (found) => delete found[name]), refusal: 'fork-error' });
  const having = (path: string, key: string, name: string, value: unknown): Broken => ({ name: `${name} ${JSON.stringify(value)}`, path, answer: inner(path, key, (found) => (found[name] = value)), refusal: 'fork-error' });
  const held = (path: string, key: string): Broken[] => [null, [], 'x'].map((value) => ({ name: `${key} ${JSON.stringify(value)}`, path, answer: () => ({ ...(books[path] as Json), [key]: value }), refusal: 'fork-error' }));
  const SHAPES: Broken[] = [
    ...['Id', 'SyncToken', 'TxnDate', 'Line'].map((name) => without('purchase/1001', 'Purchase', name)),
    ...[['Id', '1002'], ['Id', 1001], ['SyncToken', 3], ['SyncToken', null], ['TxnDate', 20261110], ['TxnDate', null], ['Line', { 0: {} }], ['Line', null], ['Line', 'x']].map(([name, value]) =>
      having('purchase/1001', 'Purchase', name as string, value),
    ),
    ...held('purchase/1001', 'Purchase'),
    ...held('preferences', 'Preferences'),
    { name: 'no AccountingInfoPrefs', path: 'preferences', answer: () => ({ Preferences: {} }), refusal: 'fork-error' },
    ...[null, [], 'x'].map((value): Broken => ({ name: `AccountingInfoPrefs ${JSON.stringify(value)}`, path: 'preferences', answer: () => ({ Preferences: { AccountingInfoPrefs: value } }), refusal: 'fork-error' })),
    { name: 'a 200 holding a Fault 610', path: 'preferences', answer: () => fault('610'), refusal: 'fork-error' },
    { name: 'a 400 holding a Fault 610', path: 'preferences', answer: () => answered(400, fault('610')), refusal: HTTP(400, SAID), failure: 'stands' },
    ...['Id', 'Active', 'AccountType'].map((name) => without('account/84', 'Account', name)),
    ...[['Id', '85'], ['Id', 84], ['Active', 'true'], ['Active', null], ['Active', 1], ['AccountType', ['Expense']], ['AccountType', null]].map(([name, value]) => having('account/84', 'Account', name as string, value)),
    ...held('account/84', 'Account'),
    { name: 'a Class for an account', path: 'account/84', answer: () => ({ Class: account('84') }), refusal: 'fork-error' },
    ...['Id', 'Active'].map((name) => without('class/12', 'Class', name)),
    ...[['Id', '13'], ['Active', 'true'], ['Active', 0]].map(([name, value]) => having('class/12', 'Class', name as string, value)),
    ...held('class/12', 'Class'),
  ];
  const ROWS = [...ALL.flatMap(ANY), ...SHAPES];
  it.each(ROWS)('$path: $name', async ({ path, answer, refusal, failure }) => {
    await allowed(P());
    expect(gets()).toEqual(ALL);
    books[path] = answer();
    const index = ALL.indexOf(path);
    const expected = ALL.slice(0, index + 1);
    if (refusal instanceof Object && refusal.reason === 'http-429') expected.push(path);
    const full = refusal instanceof Object && refusal.reason === 'http-400' && refusal.intuitTid === undefined ? HTTP(400, 'QuickBooks answered 400. QuickBooks said: 610: Object Not Found') : refusal;
    const { out, failure: recorded } = await refused(P(), full, expected);
    const { ok: _ok, ...reason } = out;
    expect(recorded).toEqual(failure === 'stands' ? reason : null);
  });

  it.each(['undo', 'dry'])('%s: an account or class that isn\'t the one asked for', async (mode) => {
    const input = mode === 'dry' ? DRY() : UNDO();
    account('84').Id = '85';
    await refused(input, 'fork-error', mode === 'dry' ? [...P_READS, 'account/77', 'account/84'] : [...P_READS, 'account/84']);
  });

  it.each([200, 400, 404, 500])('Fault 610 with status %i: the transaction is write:not-found, and the failure is gone', async (status) => {
    for (const file of ['get-missing', 'get-deleted']) {
      for (const input of [P(), UNDO(), DRY()]) {
        books['purchase/1001'] = answered(status, fixture(`faults/${file}.json`));
        const detail = { case: input.mode === 'undo' ? 'undo' : 'categorize', T: 'Purchase', id: '1001' };
        expect((await refused(input, R('write:not-found', detail), ['purchase/1001'])).failure).toBeNull();
      }
      resetBooks();
      for (const [path, reason] of [['account/84', R('write:account', { case: 'missing', id: '84' })], ['class/12', R('write:class', { case: 'missing', id: '12' })]] as const) {
        const kept = books[path];
        books[path] = answered(status, fixture(`faults/${file}.json`));
        expect((await refused(P(), reason, ALL.slice(0, ALL.indexOf(path) + 1))).failure).toBeNull();
        books[path] = kept;
      }
    }
  });

  it('a Stacks error on a 401\'s refetch is its reason', async () => {
    books['account/84'] = answered(401, {});
    stacksOpts.sequence = ['409.json'];
    await refused(P(), { reason: 'not-connected' }, [...P_READS, 'account/84']);
  });

  it.each(ALL)('a guard refusal of %s is fork-error', async (path) => {
    await allowed(P());
    refusing = path;
    const { failure } = await refused(P(), 'fork-error', ALL.slice(0, ALL.indexOf(path)));
    expect(failure).toEqual({ reason: 'fork-error' });
  });

  it('a call with no token fails with the failure it holds, or fork-error', async () => {
    await runInCall(COMPANY, async () => {
      expect(await preSend(P() as any)).toEqual({ ok: false, reason: 'fork-error' });
      recordFailure({ reason: 'stacks-auth' });
      expect(await preSend(P() as any)).toEqual({ ok: false, reason: 'stacks-auth' });
      clearFailure();
    });
    expect(net.calls).toEqual([]);
  });
});

describe('the call and the input', () => {
  it('outside a call, or for another company than the call\'s, nothing is fetched', async () => {
    expect(await preSend(P() as any)).toEqual({ ok: false, reason: 'fork-error' });
    for (const company of ['index-space', '', undefined, 'Garden3d']) await refused({ ...P(), company }, 'fork-error', []);
    expect(net.calls).toEqual([]);
  });

  const bad: Array<[string, Json]> = [
    ...['vendor', 'Purchase', 'account', undefined, null, ['purchase']].map((entity): [string, Json] => ['entity', { entity }]),
    ...['', 'x', '10 01', '1'.repeat(21), '../1', '1001\n', 1001, undefined, ['1001']].map((id): [string, Json] => ['id', { id }]),
    ...['', 'Dry', 'send', undefined, null, ['categorize']].map((mode): [string, Json] => ['mode', { mode }]),
    ...[undefined, null, {}, 'x', { length: 1, 0: P().lines[0] }, { length: 21 }, 'x'.repeat(21), [null], ['1'], [[]], Array(1)].map((lines): [string, Json] => ['lines', { lines }]),
    ...[
      { line_id: 1 }, { line_id: '' }, { line_id: 'x' }, { line_id: undefined }, { account_id: 84 }, { account_id: '' }, { account_id: '84/x' }, { account_id: undefined },
      { class_id: 12 }, { class_id: '' }, { class_id: 'x' }, { class_id: false }, { class_id: {} },
    ].map((over): [string, Json] => ['a line\'s', { lines: [{ ...P().lines[0], ...over }] }]),
  ];
  it.each(bad.map(([name, over]) => ({ name, over })))('$name $over is fork-error, nothing fetched', async ({ over }) => {
    await allowed(P());
    const beforeFetch = jest.fn(PASSES);
    guarded = [];
    for (const input of 'lines' in over || 'mode' in over ? [P(), UNDO()] : [P(), UNDO(), DRY()]) {
      await refused({ ...input, ...over, beforeFetch }, 'fork-error', []);
    }
    expect([beforeFetch.mock.calls.length, guarded.length]).toEqual([0, 0]);
  });
  it('no input at all, or one that throws when read, is fork-error', async () => {
    for (const input of [undefined, null]) await refused(input as any, 'fork-error', []);
    await refused(Object.defineProperty(P(), 'id', { get: () => { throw new Error('x'); } }), 'fork-error', []);
  });

  it('a malformed input field refuses in its own words, not a longer answer: exactly 20 digits pass the pattern', async () => {
    await refused({ ...P(), id: '1'.repeat(20) }, R('write:not-found', { case: 'categorize', T: 'Purchase', id: '1'.repeat(20) }), [`purchase/${'1'.repeat(20)}`]);
  });

  it('the input is read once, and a later change to it changes nothing', async () => {
    const input = P();
    input.beforeFetch = async () => {
      Object.assign(input.lines[0], { account_id: '91', class_id: null, line_id: '2' });
      input.lines.push({ line_id: '2', account_id: '91' });
      Object.assign(input, { id: '1002', entity: 'bill', mode: 'dry', company: 'index-space' });
      return null;
    };
    const checked = await allowed(input);
    expect(checked).toMatchObject({ company: COMPANY, entity: 'purchase', mode: 'categorize', changes: P().lines });
    expect(checked.body).toEqual(asInput('account-and-class').expected.sparse_body);
    input.lines[0].account_id = '31';
    expect(checked.changes).toEqual(P().lines);
  });

  it('lines is copied once, before the size check (TF1)', async () => {
    const proxied = (n: number, one: (read: number) => boolean) => {
      let reads = 0;
      const lines = new Proxy(changesOf(n), {
        get: (target, key) => {
          if (key !== 'length') return Reflect.get(target, key);
          reads += 1;
          return one(reads) ? 1 : n;
        },
      });
      return lines;
    };
    withLines(books['purchase/1001'] as Json, 21);
    // Whichever reads of the length answer 1, what is judged is what is copied.
    for (const one of [0, 1, 2, 3, 4, 5].flatMap((n) => [(read: number) => read <= n, (read: number) => read === n])) {
      net.calls.length = 0;
      const { out } = await ask({ ...P(), lines: proxied(21, one) });
      if (out.ok) expect(out.checked.changes.length).toBeLessThanOrEqual(20);
      else expect([out.reason, gets()]).toEqual(['write:size', []]);
    }
    const first = jest.fn(() => changesOf(1));
    const input = Object.defineProperty(P(), 'lines', { get: () => (first.mock.calls.length === 0 ? first() : changesOf(21)), enumerable: true });
    await allowed(input);
    expect(first).toHaveBeenCalledTimes(1);
    // The elements too: each is read once.
    const reads: string[] = [];
    const counted = new Proxy(changesOf(2), { get: (target, key) => (/^[0-9]+$/.test(String(key)) && reads.push(String(key)), Reflect.get(target, key)) });
    await (preSend as any)({ ...P(), lines: counted });
    expect(reads).toEqual(['0', '1']);
    for (const mode of ['categorize', 'undo']) {
      const shifting = new Proxy(changesOf(1), { get: (target, key) => (key === Symbol.iterator ? () => [changesOf(2)[1]][Symbol.iterator]() : Reflect.get(target, key)) });
      expect((await allowed({ ...P(), mode, lines: shifting })).changes.map((c: Json) => c.line_id)).toEqual(['2']);
    }
  });

  it('the input is never changed', async () => {
    const freeze = (value: any): any => (Object.values(Object(value)).forEach((v) => typeof v === 'object' && freeze(v)), Object.freeze(value));
    await allowed(freeze(P()));
    const input = P();
    await allowed(input);
    expect(input).toEqual(P());
    expect([input, input.lines, input.lines[0]].some((v) => Object.isFrozen(v))).toBe(false);
  });

  it('the fetched answer is never changed or frozen, and a later change to it changes nothing', async () => {
    const answers: Json[] = [];
    const id = ax.interceptors.response.use((response: any) => (answers.push(response.data), response));
    onRequest = (path) => {
      if (path !== 'preferences') return;
      answers[0].Purchase.TotalAmt = 1;
      answers[0].Purchase.Line[0].Amount = 1;
    };
    try {
      const checked = await allowed(P());
      expect(checked.fetched).toEqual(fixture('fetched/purchase-1001.json').Purchase);
      expect(checked.body).toEqual(asInput('account-and-class').expected.sparse_body);
      expect([answers[0], answers[0].Purchase, answers[0].Purchase.Line, answers[0].Purchase.Line[0]].some((v) => Object.isFrozen(v))).toBe(false);
      const { bodyText } = checked;
      answers[0].Purchase.Line[1].Amount = 2;
      expect([checked.fetched.Line[1].Amount, checked.body.Line[1].Amount, checked.bodyText]).toEqual([20, 20, bodyText]);
    } finally {
      ax.interceptors.response.eject(id);
    }
  });

  it('body is what bodyText parses to, whatever order the builder wrote', async () => {
    const reversed = (f: any, c: any) => Object.fromEntries([['Dropped', undefined], ...Object.entries(buildBody(f, c)).reverse()]);
    const checked = await allowed(P(), { buildBody: reversed });
    expect(JSON.stringify(checked.body)).toBe(checked.bodyText);
    expect(Object.keys(checked.body)[0]).toBe('sparse');
  });

  it('nothing in checked can be changed, and the builder\'s own object is not in it', async () => {
    const kept: Json[] = [];
    const checked = await allowed(P(), { buildBody: (f: any, c: any) => (kept.push(JSON.parse(JSON.stringify(buildBody(f, c)))), kept[0]) });
    const { bodyText } = checked;
    kept[0].Line[0].Amount = 1;
    expect(checked.body.Line[0].Amount).toBe(100);
    const deep = (value: any, path: string): void => {
      if (typeof value !== 'object' || value === null) return;
      expect([path, Object.isFrozen(value)]).toEqual([path, true]);
      for (const [key, inner] of Object.entries(value)) deep(inner, `${path}.${key}`);
    };
    for (const one of [checked, await allowed(P()), await allowed(UNDO()), await allowed(DRY())]) deep(one, 'checked');
    expect(() => (checked.bodyText = 'x')).toThrow(TypeError);
    expect(() => (checked.changes[0].account_id = '91')).toThrow(TypeError);
    expect(() => checked.changes.push({})).toThrow(TypeError);
    expect(() => (checked.body.Line[0].Amount = 1)).toThrow(TypeError);
    expect(() => (checked.fetched.Line[0].Amount = 1)).toThrow(TypeError);
    expect([checked.bodyText, checked.changes]).toEqual([bodyText, P().lines]);
  });
});

describe('A2.14: a checked request can\'t be forged', () => {
  it('only the one preSend made is checked', async () => {
    const checked = await allowed(P());
    expect(isChecked(checked)).toBe(true);
    expect(Object.isFrozen(checked)).toBe(true);
    const Made: any = checked.constructor;
    const forged = [{ ...checked }, structuredClone(checked), Object.create(Object.getPrototypeOf(checked)), Object.create(checked), Object.assign(Object.create(Made.prototype), checked), new Proxy(checked, {})];
    for (const one of [...forged, undefined, null, 'x', 5, checked.bodyText]) expect(isChecked(one)).toBe(false);
    for (const token of [undefined, Symbol('pre-send'), Symbol.for('pre-send'), 'pre-send']) {
      expect(() => new Made(token, { ...checked })).toThrow(new TypeError('a checked request is made by preSend only'));
    }
    expect(isChecked(checked)).toBe(true);
  });

  it('its class can\'t be changed, and its fields are its own (TF2)', async () => {
    // One fixed mono, so checkedAt agrees across the two checks (QA1).
    const before = await allowed(P(), { mono: () => 7 });
    const proto = Object.getPrototypeOf(before);
    expect([Object.isFrozen(proto), Object.isFrozen(proto.constructor)]).toEqual([true, true]);
    const planted = { get: () => 'planted', set: () => undefined, configurable: true };
    for (const key of ['bodyText', 'mode', 'other']) expect(() => Object.defineProperty(proto, key, planted)).toThrow(TypeError);
    expect(() => Object.setPrototypeOf(proto, { bodyText: 'planted' })).toThrow(TypeError);
    const KEYS = ['company', 'entity', 'mode', 'fetched', 'changes', 'body', 'bodyText', 'checkedAt', 'names'];
    // An accessor above the frozen prototype takes no write either.
    let checked: Json;
    for (const key of ['bodyText', 'mode']) Object.defineProperty(Object.prototype, key, planted);
    try {
      checked = await allowed(P(), { mono: () => 7 });
    } finally {
      for (const key of ['bodyText', 'mode']) delete (Object.prototype as any)[key];
    }
    for (const one of [before, checked]) {
      expect(Object.keys(one).sort()).toEqual([...KEYS].sort());
      for (const key of KEYS) {
        expect(Object.getOwnPropertyDescriptor(one, key)).toEqual({ value: before[key], enumerable: true, writable: false, configurable: false });
      }
    }
  });

  it('pre-send.ts exports exactly these (SB2, E3)', () => {
    expect(Object.keys(preSendModule).sort()).toEqual(['isChecked', 'preSend', 'ruleClosed', 'ruleLines', 'ruleStacksBill', 'ruleSubjectLine', 'ruleType']);
  });
});

describe('QA1: checkedAt, from the registry\'s kind of clock', () => {
  it('is what deps.mono answers, asked once, after the last GET and the body check', async () => {
    for (const input of [P(), UNDO(), DRY()]) {
      net.calls.length = 0;
      const seen: number[] = [];
      const build = jest.fn(buildBody);
      const checked = await allowed(input, { mono: () => (seen.push(gets().length, build.mock.calls.length), 1234.5), buildBody: build });
      expect([checked.checkedAt, seen]).toEqual([1234.5, [gets().length, 1]]);
    }
  });
  it('a refused check never reads the clock', async () => {
    const mono = jest.fn(() => 5);
    await refused(P(), R('write:diff'), [...P_READS, 'account/84', 'class/12'], { mono, buildBody: () => ({}) });
    account('84').Active = false;
    await refused(P(), R('write:account', { case: 'inactive', id: '84' }), [...P_READS, 'account/84'], { mono });
    expect(mono).not.toHaveBeenCalled();
  });
  it('with no mono, performance.now, called as a method (a bare one throws once detached)', async () => {
    const low = performance.now();
    const { checkedAt } = await allowed(P());
    expect(checkedAt).toBeGreaterThanOrEqual(low);
    expect(checkedAt).toBeLessThanOrEqual(performance.now());
    jest.spyOn(performance, 'now').mockReturnValue(42);
    jest.spyOn(Date, 'now').mockReturnValue(1e12);
    expect((await allowed(P(), {})).checkedAt).toBe(42);
  });
  it('an answer that is no number is NaN, which no registry takes; any number is kept as it is', async () => {
    for (const value of ['5', 5n, null, undefined, {}, { valueOf: () => 5 }, true]) expect(Number.isNaN((await allowed(P(), { mono: () => value })).checkedAt)).toBe(true);
    for (const value of [0, -1, Infinity, -Infinity, 1e300]) expect((await allowed(P(), { mono: () => value })).checkedAt).toBe(value);
  });
  it('a clock that throws is fork-error', async () => {
    await refused(P(), 'fork-error', [...P_READS, 'account/84', 'class/12'], { mono: () => { throw new Error('x'); } });
  });
});

describe('P12: the checked request keeps each name steps 9 and 10 read, keyed by entity and id', () => {
  it('categorize: the new account\'s and class\'s, frozen, nothing else', async () => {
    const { names } = await allowed(P());
    expect(names).toEqual({ 'account:84': 'Software', 'class:12': 'Client Delivery' });
    expect(Object.keys(names)).toEqual(['account:84', 'class:12']);
    expect(Object.isFrozen(names)).toBe(true);
  });
  it('an account and a class of one id keep their own names', async () => {
    books['account/12'] = { Account: { ...account('84'), Id: '12', Name: 'Twelve Expense' } };
    const { names } = await allowed({ ...P(), lines: [{ line_id: '1', account_id: '12', class_id: '12' }] });
    expect(names).toEqual({ 'account:12': 'Twelve Expense', 'class:12': 'Client Delivery' });
  });
  it('each distinct id once, in the order read; a cleared or kept class reads and names none', async () => {
    withLines(books['purchase/1001'] as Json, 4);
    const lines = [
      { line_id: '4', account_id: '91', class_id: '13' },
      { line_id: '1', account_id: '84', class_id: '12' },
      { line_id: '3', account_id: '91', class_id: null },
      { line_id: '2', account_id: '84' },
    ];
    const { names } = await allowed({ ...P(), lines });
    expect(Object.entries(names)).toEqual([['account:91', 'Contractors'], ['account:84', 'Software'], ['class:13', 'Studio'], ['class:12', 'Client Delivery']]);
  });
  it('undo: the before values\' names; dry: every line\'s', async () => {
    expect((await allowed(UNDO())).names).toEqual({ 'account:84': 'Software', 'class:12': 'Client Delivery' });
    expect((await allowed(DRY())).names).toEqual({ 'account:77': 'Uncategorized Expense', 'account:84': 'Software', 'class:12': 'Client Delivery' });
  });
  it('a Name that is no string or is empty is left out, and the check still passes (the caller decides: spec §3 "gap: intent names")', async () => {
    for (const name of [undefined, '', 5, null, ['Software'], { value: 'Software' }] as unknown[]) {
      account('84').Name = name;
      cls('12').Name = name;
      expect((await allowed(P())).names).toEqual({});
    }
    account('84').Name = ' ';
    expect((await allowed(P())).names).toEqual({ 'account:84': ' ' });
  });
});

describe('P10: each pure rule\'s detail names its case', () => {
  const txn = (lines: Json[]): Json => ({ Line: lines });
  const acct = (Id: string): Json => ({ Id, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: { value: '77' } } });
  const item = (Id: string): Json => ({ Id, DetailType: 'ItemBasedExpenseLineDetail' });
  const named = (...ids: string[]) => ids.map((line_id) => ({ line_id }));
  it('line, in step 8\'s order: none named, then the fetched ids, then the first named line in call order that is missing or not account-based, then the first named again', () => {
    const t = txn([acct('1'), item('2'), acct('3')]);
    expect(ruleLines(t, [])).toEqual(R('write:line', { case: 'none' }));
    expect(ruleLines(txn([]), [])).toEqual(R('write:line', { case: 'none' }));
    expect(ruleLines(txn([acct('1'), acct('1')]), named('1'))).toEqual(R('write:line', { case: 'ids' }));
    expect(ruleLines(txn([acct('1'), acct('1')]), named('9', '9'))).toEqual(R('write:line', { case: 'ids' }));
    expect(ruleLines(t, named('9', '2'))).toEqual(R('write:line', { case: 'missing', id: '9' }));
    expect(ruleLines(t, named('2', '9'))).toEqual(R('write:line', { case: 'not-account', id: '2' }));
    expect(ruleLines(t, named('1', '1', '9'))).toEqual(R('write:line', { case: 'missing', id: '9' }));
    expect(ruleLines(t, named('1', '1', '2'))).toEqual(R('write:line', { case: 'not-account', id: '2' }));
    expect(ruleLines(t, named('1', '3', '1', '3'))).toEqual(R('write:line', { case: 'twice', id: '1' }));
    expect(ruleLines(t, named('3', '1', '3', '1'))).toEqual(R('write:line', { case: 'twice', id: '3' }));
    expect(ruleLines(t, named('1', '3', '3', '1'))).toEqual(R('write:line', { case: 'twice', id: '3' }));
    expect(ruleLines(t, named('1', '3'))).toBeNull();
  });
  it('subject line: none account-based, else the fetched ids', () => {
    expect(ruleSubjectLine(txn([item('1')]))).toEqual(R('write:line', { case: 'subject' }));
    expect(ruleSubjectLine(txn([acct('1'), { DetailType: 'AccountBasedExpenseLineDetail' }]))).toEqual(R('write:line', { case: 'ids' }));
  });
  it('type: the asked entity\'s name when another came, before a Credit', () => {
    expect(ruleType('purchase', { Bill: { Credit: true } })).toEqual(R('write:type', { case: 'entity', T: 'Purchase' }));
    expect(ruleType('bill', { Purchase: {} })).toEqual(R('write:type', { case: 'entity', T: 'Bill' }));
    expect(ruleType('purchase', { Purchase: { Credit: true }, Bill: {} })).toEqual(R('write:type', { case: 'entity', T: 'Purchase' }));
    expect(ruleType('purchase', { Purchase: { Credit: true } })).toEqual(R('write:type', { case: 'credit' }));
  });
  it('stacks-bill: DocNumber before PrivateNote', () => {
    expect(ruleStacksBill('bill', { DocNumber: 'Stacks_1', PrivateNote: 'garden3d invoice' })).toEqual(R('write:stacks-bill', { case: 'doc-number' }));
    expect(ruleStacksBill('bill', { DocNumber: 'x', PrivateNote: 'garden3d invoice' })).toEqual(R('write:stacks-bill', { case: 'private-note' }));
  });
  it('closed: a close date that is no date is unreadable in every mode; a TxnDate not after it is before-send, or undo\'s own', () => {
    const on = { TxnDate: '2026-11-10' };
    for (const undo of [false, true]) expect(ruleClosed(on, { BookCloseDate: '2026-02-30' }, undo)).toEqual(R('write:closed', { case: 'unreadable' }));
    expect(ruleClosed(on, { BookCloseDate: '2026-11-10' })).toEqual(R('write:closed', { case: 'before-send' }));
    expect(ruleClosed(on, { BookCloseDate: '2026-11-10' }, false)).toEqual(R('write:closed', { case: 'before-send' }));
    expect(ruleClosed(on, { BookCloseDate: '2026-11-10' }, true)).toEqual(R('write:closed', { case: 'undo' }));
    expect(ruleClosed({ TxnDate: 'x' }, { BookCloseDate: '2026-11-10' }, true)).toEqual(R('write:closed', { case: 'undo' }));
    expect(ruleClosed(on, { BookCloseDate: '2026-11-09' }, true)).toBeNull();
  });
  it('noop and the size, diff and hook refusals have no case: an empty detail', async () => {
    expect(ruleNoop(txn([acct('1')]), [{ line_id: '1', account_id: '77' }])).toEqual(R('write:noop'));
    expect((await ask({ ...P(), afterLine: () => 'write:changed-since' })).out.detail).toEqual({});
  });
  it('a fork reason carries no detail', async () => {
    const { out } = await ask({ ...P(), company: 'index-space' });
    expect(out).toEqual({ ok: false, reason: 'fork-error' });
    expect('detail' in out).toBe(false);
  });
});
