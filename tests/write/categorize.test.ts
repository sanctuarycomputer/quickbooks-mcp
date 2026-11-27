// Sanctuary Computer (quickbooks-mcp-294): the two categorize tools through the write server (spec DW1 and DW3; contract 1.2 §15, §17):
// the order of every request and receipt (A1.1), the intent's text (A1.3), the one send (A1.5), each Send answers step (A1.6, A1.7), the
// refetch of an unanswered send (A1.8), the differing Id (A1.9), QA4's forced token (A1.15), the sweep gate per stamp (A2.10), the schemas
// (A3.2), V3's three cases, and the race. Each result is compared whole with its tool-results/ file; A3.3's coverage list is checked last.
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fakePath, fixtureToken, REALMS } from '../helpers/server.js';
import { nameFiltered } from '../helpers/name-filter.js';
import { readError } from '../helpers/result-grammar.js';
import { forkReason } from '../../src/write/results.js';
import { digests } from '../../src/write/compare.js';
import { runReceipt } from '../../src/write/receipt-cmd.js';
import { createKit } from '../../src/write/kit.js';
import { loadWriteConfig } from '../../src/clients/config.js';
import { entityOf, fixture, withLines, type Json } from './derive.js';
import { vector } from './receipt-fake.js';
import { STAMP_NOW, stubOf, world, writeRig, type World } from './write-rig.js';

jest.setTimeout(30000);
const rig = writeRig();

const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const PURCHASE = 'qbo_categorize_purchase';
const BILL = 'qbo_categorize_bill';
const toolCall = (name: string): Json => JSON.parse(readFileSync(fakePath(`tool-calls/${name}.json`), 'utf8'));
const expected = (rel: string): Json => JSON.parse(readFileSync(fakePath(`tool-results/${rel}`), 'utf8'));
/** A3.3: each tool-results file some test here compared whole. */
const produced = new Set<string>();
const expectFile = (result: unknown, rel: string): void => {
  expect(result).toEqual(expected(rel));
  produced.add(rel);
};
/** A success file with its change item's keys replaced. */
const successWith = (rel: string, over: Json): Json => {
  const item = JSON.parse(expected(rel).content[0].text);
  return { content: [{ type: 'text', text: JSON.stringify({ ...item, ...over }) }] };
};
/** An error file with a header line put in after `after`. */
const errorWith = (rel: string, after: string, line: string): Json => {
  const file = expected(rel);
  const lines = file.content[0].text.split('\n');
  lines.splice(lines.findIndex((l: string) => l.startsWith(`${after}: `)) + 1, 0, line);
  return { ...file, content: [{ type: 'text', text: lines.join('\n') }] };
};
type ToolCall = { name: string; arguments: Json };
const args = (name = PURCHASE, params: Json = {}): ToolCall => {
  const base = toolCall(name === BILL ? 'qbo_categorize_bill' : 'qbo_categorize_purchase');
  return { name, arguments: { ...base, params: { ...base.params, ...params } } };
};
/** 297's update-sent answer, its stored Purchase changed by `edit`. */
const stored = (edit: (txn: Json) => void = () => undefined, headers: Record<string, string> = {}) => {
  const file = fixture('answers/update-sent.json');
  edit(file.body.Purchase);
  return stubOf(file, headers);
};
const answerFile = (name: string, headers: Record<string, string> = {}) => stubOf(fixture(`answers/${name}`), headers);
const fault = (code: string, status = 400, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: JSON.stringify({ Fault: { Error: [{ Message: 'm', Detail: 'd', code }], type: 'ValidationFault' }, time: '2026-11-18T09:00:00.000-08:00' }),
});
/** The fake's logged requests, by cmd. */
const cmds = (w: World): string[] => w.fake.requests().map((r: any) => r.cmd);
const OK_SCRIPT = { intent: ['intent-ok.json'], outcome: ['outcome-sent.json'] };
const purchaseMoved = (): Json => fixture('answers/update-sent.json').body;

describe('A1.1: the order, and every check run', () => {
  it('Purchase 1001: companyinfo once, the pre-send GETs, the name GET, then one POST; the intent before the POST, then the outcome', async () => {
    const w = world(rig, { intent: ['intent-ok.json', { answer: { ok: true, key: KEY.replace(/1$/, '2'), n: 2 } }], outcome: ['outcome-sent.json', 'outcome-sent.json'] });
    const atPost: string[][] = [];
    w.post = () => (atPost.push(cmds(w)), stored());
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/sent.json');
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET purchase/1001', 'GET preferences', 'GET account/84', 'GET class/12', 'GET account/77', 'POST purchase']);
    expect(atPost).toEqual([['intent']]);
    expect(cmds(w)).toEqual(['intent', 'outcome']);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-sent.json').request));
    rig.net.calls.length = 0;
    // A second call in the same server: no companyinfo GET.
    expect(await client.callTool(args())).toEqual(successWith('qbo_categorize_purchase/sent.json', { receipt: KEY.replace(/1$/, '2') }));
    expect(rig.qbo()).toEqual(['GET purchase/1001', 'GET preferences', 'GET account/84', 'GET class/12', 'GET account/77', 'POST purchase']);
  });

  const refusals: Array<[string, (w: World) => void, ToolCall, string]> = [
    ['not-found (610)', (w) => (w.books['purchase/1001'] = { answer: { status: 400, body: JSON.stringify(fixture('faults/get-missing.json')) } }), args(), 'qbo_categorize_purchase/not-found.json'],
    ['type (a credit)', (w) => (w.books['purchase/1002'] = fixture('fetched/purchase-1002-credit.json')), args(PURCHASE, { id: '1002' }), 'qbo_categorize_purchase/type.json'],
    ['stacks-bill (DocNumber)', (w) => (w.books['bill/2002'] = fixture('fetched/bill-2002-stacks.json')), args(BILL, { id: '2002' }), 'qbo_categorize_bill/stacks-bill.json'],
    ['stacks-bill (PrivateNote)', (w) => (w.books['bill/2003'] = fixture('fetched/bill-2003-intercompany.json')), args(BILL, { id: '2003' }), 'qbo_categorize_bill/stacks-bill-intercompany.json'],
    ['closed (on the close date)', (w) => (w.books['purchase/1004'] = fixture('fetched/purchase-1004-on-close-date.json')), args(PURCHASE, { id: '1004' }), 'qbo_categorize_purchase/closed.json'],
    [
      'line (line 3 not account-based)',
      (w) => {
        const answer = fixture('fetched/purchase-1001.json');
        answer.Purchase.Line.push({ ...fixture('fetched/purchase-1003-item-line.json').Purchase.Line[0], Id: '3' });
        w.books['purchase/1001'] = answer;
      },
      args(PURCHASE, { lines: [{ line_id: '3', account_id: '84' }] }),
      'qbo_categorize_purchase/line.json',
    ],
    ['account (40, Income)', () => undefined, args(PURCHASE, { lines: [{ line_id: '1', account_id: '40' }] }), 'qbo_categorize_purchase/account.json'],
    ['class (13 inactive)', (w) => ((w.books['class/13'] as Json).Class.Active = false), args(PURCHASE, { lines: [{ line_id: '1', account_id: '84', class_id: '13' }] }), 'qbo_categorize_purchase/class.json'],
    ['noop', () => undefined, args(PURCHASE, { lines: [{ line_id: '2', account_id: '84', class_id: '12' }] }), 'qbo_categorize_purchase/noop.json'],
    ['size (21 lines)', () => undefined, args(PURCHASE, { lines: Array.from({ length: 21 }, (_, i) => ({ line_id: String(i + 1), account_id: '84' })) }), 'qbo_categorize_purchase/size.json'],
  ];
  it.each(refusals)('refused by %s: that rule’s result, the fake’s log empty, no POST', async (_label, setup, call, rel) => {
    const w = world(rig, OK_SCRIPT);
    setup(w);
    const { client } = await w.start();
    expectFile(await client.callTool(call), rel);
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });

  it('the transaction’s GET answered 500: its 1.0 reason (http-500), nothing run or sent', async () => {
    const w = world(rig, OK_SCRIPT);
    w.books['purchase/1001'] = { answer: { status: 500, body: '{}' } };
    const { client } = await w.start();
    expect(readError(await client.callTool(args())).reason).toBe('http-500');
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });

  it('refused by diff (the test seam deps.buildBody, A3.5): diff.json, nothing run or sent', async () => {
    const w = world(rig, OK_SCRIPT);
    const { client } = await w.start({ buildBody: (fetched, changes) => ({ ...createKit().buildBody(fetched, changes), TotalAmt: 1 }) });
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/diff.json');
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });

  it('a prepare refused by Stacks (403): stacks-auth.json, 286’s text less (403), nothing fetched from QuickBooks', async () => {
    const w = world(rig, OK_SCRIPT);
    rig.stacks = (await import('../fakes/stacks-token.js')).stacksFake({ byKey: { garden3d: '403.json' } });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/stacks-auth.json');
    expect([rig.qbo(), w.fake.log()]).toEqual([[], []]);
  });

  const nameCases: Array<[string, (w: World) => void, (r: unknown) => void]> = [
    ['answered 500: http-500', (w) => (w.books['account/77'] = { answer: { status: 500, body: '{}' } }), (r) => expect(readError(r).reason).toBe('http-500')],
    ['answered 610: fork-error', (w) => (w.books['account/77'] = { answer: { status: 400, body: JSON.stringify(fixture('faults/get-deleted.json')) } }), (r) => expect(r).toEqual(forkReason({ reason: 'fork-error' }))],
    ['with no Name: fork-error', (w) => delete (w.books['account/77'] as Json).Account.Name, (r) => expect(r).toEqual(forkReason({ reason: 'fork-error' }))],
    ['with Name "": fork-error', (w) => ((w.books['account/77'] as Json).Account.Name = ''), (r) => expect(r).toEqual(forkReason({ reason: 'fork-error' }))],
    ['for another Id: fork-error', (w) => ((w.books['account/77'] as Json).Account.Id = '78'), (r) => expect(r).toEqual(forkReason({ reason: 'fork-error' }))],
    ['reset: its 1.0 reason', () => (rig.fail = (c) => (c.path?.includes('/account/77') ? 'reset' : undefined)), (r) => expect(readError(r).reason).toBe('fork-error')],
  ];
  it.each(nameCases)('the name GET %s, with no intent and no POST', async (_label, setup, check) => {
    const w = world(rig, OK_SCRIPT);
    setup(w);
    const { client } = await w.start();
    check(await client.callTool(args()));
    expect(rig.qbo().at(-1)).toBe('GET account/77');
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });

  it('an after account step 9 read with no usable Name: fork-error, and no second GET of it', async () => {
    const w = world(rig, OK_SCRIPT);
    delete (w.books['account/84'] as Json).Account.Name;
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(forkReason({ reason: 'fork-error' }));
    expect(rig.qbo().filter((r) => r === 'GET account/84')).toHaveLength(1);
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });

  it('a before account that is no id (fetched as "x"): fork-error before any name GET', async () => {
    const w = world(rig, OK_SCRIPT);
    (w.books['purchase/1001'] as Json).Purchase.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = 'x';
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(forkReason({ reason: 'fork-error' }));
    expect(rig.qbo().at(-1)).toBe('GET class/12');
    expect(w.fake.log()).toEqual([]);
  });

  it('a kept class: its name from one class/12 GET, on both sides of the intent’s line (a derived call on line 2)', async () => {
    const w = world(rig, { intent: [{ answer: { ok: false } }] });
    const { client } = await w.start();
    expectFile(await client.callTool(args(PURCHASE, { lines: [{ line_id: '2', account_id: '91' }] })), 'qbo_categorize_purchase/receipt-failed.json');
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET purchase/1001', 'GET preferences', 'GET account/91', 'GET account/84', 'GET class/12']);
    const side = (account_id: string, account_name: string) => ({ account_id, account_name, class_id: '12', class_name: 'Client Delivery' });
    expect((w.fake.requests()[0] as Json).lines).toEqual([{ line_id: '2', before: side('84', 'Software'), after: side('91', 'Contractors') }]);
  });

  it('one GET per id per call: two lines naming the same before account and class read each once', async () => {
    const w = world(rig, { intent: [{ answer: { ok: false } }] });
    const answer = fixture('fetched/purchase-1001.json');
    answer.Purchase.Line[0].AccountBasedExpenseLineDetail = { AccountRef: { value: '86' }, ClassRef: { value: '19' } };
    answer.Purchase.Line[1].AccountBasedExpenseLineDetail = { AccountRef: { value: '86' }, ClassRef: { value: '19' } };
    w.books['purchase/1001'] = answer;
    const { client } = await w.start();
    await client.callTool(args(PURCHASE, { lines: [{ line_id: '1', account_id: '84' }, { line_id: '2', account_id: '91' }] }));
    expect(rig.qbo().slice(3)).toEqual(['GET account/84', 'GET account/91', 'GET account/86', 'GET class/19']);
    expect(cmds(w)).toEqual(['intent']);
  });

  it('exactly 20 named lines on a derived 20-line Purchase pass size (the intent is asked)', async () => {
    const w = world(rig, { intent: [{ answer: { ok: false } }] });
    w.books['purchase/1001'] = withLines(fixture('fetched/purchase-1001.json'), 20);
    const { client } = await w.start();
    expectFile(await client.callTool(args(PURCHASE, { lines: Array.from({ length: 20 }, (_, i) => ({ line_id: String(i + 1), account_id: '84' })) })), 'qbo_categorize_purchase/receipt-failed.json');
    expect(cmds(w)).toEqual(['intent']);
  });
});

describe('A1.3: the intent’s request', () => {
  it('Purchase 1001: as text, intent-ok.json’s request, its digests sorted and equal to digests(fetched, ["1"])', async () => {
    const w = world(rig, OK_SCRIPT);
    w.post = () => stored();
    const { client } = await w.start();
    await client.callTool(args());
    const intent = w.fake.requests()[0] as Json;
    expect(JSON.stringify(intent)).toBe(JSON.stringify(vector('intent-ok.json').request));
    const fetched = entityOf(fixture('fetched/purchase-1001.json'));
    expect(intent.digests).toEqual(digests(fetched, ['1']));
    expect(Object.keys(intent.digests)).toEqual(Object.keys(intent.digests).sort());
  });

  it('Bill 2001: intent-bill.json’s request with the call’s own reason, as text; the bill sends to bill/sent.json', async () => {
    const w = world(rig, { intent: ['intent-bill.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => {
      const bill = fixture('fetched/bill-2001.json');
      bill.Bill.SyncToken = '1';
      bill.Bill.Line[0].AccountBasedExpenseLineDetail.AccountRef = { value: '91' };
      delete bill.Bill.MetaData;
      return { status: 200, body: JSON.stringify(bill) };
    };
    const { client } = await w.start();
    expectFile(await client.callTool(args(BILL)), 'qbo_categorize_bill/sent.json');
    const want = { ...vector('intent-bill.json').request, reason: 'Freelancer invoice for November.' };
    expect(JSON.stringify(w.fake.requests()[0])).toBe(JSON.stringify(want));
  });

  it('S1: the fake answers bad-request to the same request with its digests in digests()’ own order', async () => {
    const fake = rig.receipt({ intent: ['intent-ok.json'] });
    const request = vector('intent-ok.json').request;
    const unsorted = { ...request, digests: digests(entityOf(fixture('fetched/purchase-1001.json')), ['1']) };
    expect(Object.keys(unsorted.digests)).not.toEqual(Object.keys(unsorted.digests).sort());
    fake.malformed(unsorted);
    const cfg = loadWriteConfig({ ...(await import('./write-rig.js')).writeEnv({ QBO_WRITE_RECEIPT_CMD: fake.cmd }) });
    expect(await runReceipt(cfg, unsorted, { spawn: createKit().spawn })).toEqual({ ok: false, reason: 'bad-request', cause: 'bad-request' });
  });
});

describe('A1.5: sent once', () => {
  const kinds: Array<[string, (w: World) => void]> = [
    ['a 200 stored', (w) => (w.post = () => stored())],
    ['a 401 with no body', (w) => (w.post = () => ({ status: 401, body: '' }))],
    ['a 401 with a Fault', (w) => (w.post = () => fault('6000', 401))],
    ['a 429 with Retry-After: 1', (w) => (w.post = () => ({ status: 429, headers: { 'Retry-After': '1' }, body: '{}' }))],
    ['a 500 with no Fault', (w) => (w.post = () => ({ status: 500, body: '{}' }))],
    ['a Fault 5010', (w) => (w.post = () => answerFile('stale.json'))],
    ['a timeout', () => (rig.fail = (c) => (c.method === 'POST' ? 'timeout' : undefined))],
    ['a reset', () => (rig.fail = (c) => (c.method === 'POST' ? 'reset' : undefined))],
  ];
  it.each(kinds)('%s: exactly one POST in the call', async (_label, setup) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    setup(w);
    const { client } = await w.start();
    await client.callTool(args());
    expect(rig.posts()).toHaveLength(1);
    expect(cmds(w)).toEqual(['intent', 'outcome']);
  });

  it('a second tool call for the same change makes its own check and intent (a new attempt)', async () => {
    const w = world(rig, { intent: ['intent-ok.json', { answer: { ok: true, key: KEY.replace(/1$/, '2'), n: 2 } }], outcome: ['outcome-stale.json', 'outcome-sent.json'] });
    w.post = (_c, n) => (n === 0 ? answerFile('stale.json') : stored());
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/stale.json');
    rig.net.calls.length = 0;
    expect(await client.callTool(args())).toEqual(successWith('qbo_categorize_purchase/sent.json', { receipt: KEY.replace(/1$/, '2') }));
    expect(rig.qbo()).toEqual(['GET purchase/1001', 'GET preferences', 'GET account/84', 'GET class/12', 'GET account/77', 'POST purchase']);
    expect(cmds(w)).toEqual(['intent', 'outcome', 'intent', 'outcome']);
  });
});

describe('A1.6: stored, then the compare', () => {
  it('a body built here differing in Line:2 and TotalAmt: sent-diff.json, outcome-sent-diff.json’s request as text, the switch gone', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-sent-diff.json'] });
    w.post = () =>
      stored((txn) => {
        txn.Line[1].Amount = 21;
        txn.TotalAmt = 121;
      });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/sent-diff.json');
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-sent-diff.json').request));
    expect(readdirSync(w.dir)).not.toContain('write-enabled');
  });

  it.each([
    ['stored-amount.json', ['Line:1']],
    ['stored-dropped-line.json', ['Line:2']],
    ['stored-header.json', ['PaymentType']],
    ['stored-unnamed-account.json', ['Line:2']],
  ])('%s: sent-diff naming %j, writes_off true, the switch gone', async (file, diff) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => answerFile(file);
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(successWith('qbo_categorize_purchase/sent-diff.json', { diff }));
    expect(w.fake.requests()[1]).toEqual({ ...vector('outcome-sent-diff.json').request, diff });
    expect(readdirSync(w.dir)).not.toContain('write-enabled');
  });

  it('clear-class: sent-clear-class.json', async () => {
    const w = world(rig, { intent: [{ answer: { ok: true, key: KEY, n: 1 } }], outcome: ['outcome-sent.json'] });
    w.post = () =>
      stored((txn) => {
        txn.Line[0].AccountBasedExpenseLineDetail = { AccountRef: { value: '77' } };
        txn.Line[1].AccountBasedExpenseLineDetail = { AccountRef: { value: '84' } };
      });
    const { client } = await w.start();
    expectFile(await client.callTool(args(PURCHASE, toolCall('qbo_categorize_purchase-clear-class').params)), 'qbo_categorize_purchase/sent-clear-class.json');
    const side = (class_id: string | null, class_name: string | null) => ({ account_id: '84', account_name: 'Software', class_id, class_name });
    expect((w.fake.requests()[0] as Json).lines).toEqual([{ line_id: '2', before: side('12', 'Client Delivery'), after: side(null, null) }]);
  });
});

describe('A1.7: the other answers, each Send answers step through the server', () => {
  it('Fault 5010: stale.json, outcome-stale.json’s request', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-stale.json'] });
    w.post = () => answerFile('stale.json');
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/stale.json');
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-stale.json').request));
  });
  it('Fault 5010 with intuit_tid fake-tid-0004: stale.json with the tid after receipt', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-stale.json'] });
    w.post = () => answerFile('stale.json', { intuit_tid: 'fake-tid-0004' });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(errorWith('qbo_categorize_purchase/stale.json', 'receipt', 'intuit_tid: fake-tid-0004'));
  });
  it('Fault 6210 with fake-tid-0003: closed-after-send.json, the outcome failed with that code and tid', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => fault('6210', 400, { intuit_tid: 'fake-tid-0003' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/closed-after-send.json');
    expect(w.fake.requests()[1]).toEqual({ ...vector('outcome-failed.json').request, error: { code: '6210', intuit_tid: 'fake-tid-0003' } });
  });
  it('Fault 6000 with fake-tid-0002: failed.json, outcome-failed.json’s request as text', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-failed.json'] });
    w.post = () => fault('6000', 400, { intuit_tid: 'fake-tid-0002' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/failed.json');
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-failed.json').request));
  });
  it('Fault 6200, no tid: write:closed with code 6200, the outcome’s intuit_tid null', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => fault('6200');
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual({
      content: [{ type: 'text', text: `reason: write:closed\nreceipt: ${KEY}\ncode: 6200\n\nQuickBooks says the books are closed.` }],
      isError: true,
    });
    expect((w.fake.requests()[1] as Json).error).toEqual({ code: '6200', intuit_tid: null });
  });
  it('a Fault in a 200 decides as in a 400', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-failed.json'] });
    w.post = () => fault('6000', 200, { intuit_tid: 'fake-tid-0002' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/failed.json');
    expect(rig.qbo().at(-1)).toBe('POST purchase');
  });
  it.each([
    ['a Fault whose code is off its pattern', () => fault('60 00')],
    ['a stored answer whose SyncToken isn’t digits', () => stored((txn) => (txn.SyncToken = '4a'))],
  ])('%s is no answer: the refetch, then unknown (unmoved)', async (_label, answer) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = answer;
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    expect(rig.qbo().slice(-2)).toEqual(['POST purchase', 'GET purchase/1001']);
  });
  it('a 500 with no Fault and intuit_tid fake-tid-0005, refetch unmoved: unknown.json with the tid after receipt', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 500, headers: { intuit_tid: 'fake-tid-0005' }, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(errorWith('qbo_categorize_purchase/unknown.json', 'receipt', 'intuit_tid: fake-tid-0005'));
  });
});

describe('A1.8: no answer, the refetch at once', () => {
  const noAnswer: Array<[string, (w: World) => void]> = [
    ['a timeout', () => (rig.fail = (c) => (c.method === 'POST' ? 'timeout' : undefined))],
    ['a reset', () => (rig.fail = (c) => (c.method === 'POST' ? 'reset' : undefined))],
    ['a 500 with no Fault', (w) => (w.post = () => ({ status: 500, body: '{}' }))],
    ['a 401 with no Fault', (w) => (w.post = () => ({ status: 401, body: '' }))],
    ['a 429', (w) => (w.post = () => ({ status: 429, body: '{}' }))],
    ['a 2xx with no entity', (w) => (w.post = () => ({ status: 200, body: '{"time":"x"}' }))],
    ['a 2xx whose entity has no Id', (w) => (w.post = () => stored((txn) => delete txn.Id))],
  ];
  it.each(noAnswer)('%s: the next QuickBooks request is the refetch; unmoved is unknown.json, outcome-unknown.json’s request', async (_label, setup) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    setup(w);
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    expect(rig.qbo().slice(-2)).toEqual(['POST purchase', 'GET purchase/1001']);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-unknown.json').request));
  });

  it('a POST the guard refused before it left (registered, but not in the guard’s registry): the refetch, unknown', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    const { writeMode } = await import('../../src/write/mode.js');
    const { categorizeTool } = await import('../../src/write/categorize.js');
    const mode = writeMode({ wall: () => STAMP_NOW });
    const other = writeMode().registry;
    const tools = [categorizeTool('purchase', { registry: other, sw: mode.sw, kit: mode.kit }), ...mode.tools.slice(1)];
    const { client } = await w.start({}, { mode, tools });
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    expect(rig.qbo().slice(-1)).toEqual(['GET purchase/1001']);
    expect(rig.posts()).toEqual([]);
  });

  const moved: Array<[string, () => Json, Json]> = [
    ['moved by one with the after values: sent', () => purchaseMoved(), expected('qbo_categorize_purchase/sent.json')],
    ['moved by two with the after values: sent, compared against the refetch', () => fixture('refetch/purchase-1001-moved-by-two.json'), successWith('qbo_categorize_purchase/sent.json', { sync_token_after: '5' })],
  ];
  it.each(moved)('%s', async (_label, refetched, want) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => ((w.books['purchase/1001'] = refetched()), { status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(want);
  });

  it.each<[string, () => Json]>([
    ['moved without the after values', () => ((t) => ((t.Purchase.SyncToken = '4'), t))(fixture('fetched/purchase-1001.json'))],
    ['a lower SyncToken', () => ((t) => ((t.Purchase.SyncToken = '2'), t))(purchaseMoved())],
    ['a non-digit SyncToken', () => ((t) => ((t.Purchase.SyncToken = 'x'), t))(purchaseMoved())],
    ['another Id', () => ((t) => ((t.Purchase.Id = '1009'), t))(purchaseMoved())],
    ['a named line gone', () => ((t) => (t.Purchase.Line.shift(), t))(purchaseMoved())],
    ['a ClassRef with no string value', () => ((t) => ((t.Purchase.Line[0].AccountBasedExpenseLineDetail.ClassRef = { value: 12 }), t))(purchaseMoved())],
    ['no Line array', () => ((t) => (delete t.Purchase.Line, t))(purchaseMoved())],
  ])('%s: unknown', async (_label, refetched) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ((w.books['purchase/1001'] = refetched()), { status: 500, body: '{}' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
  });

  it.each<[string, (w: World) => void]>([
    ['500', (w) => (w.books['purchase/1001'] = { answer: { status: 500, body: '{}' } })],
    ['a timeout', () => (rig.fail = (c) => (c.method === 'GET' && c.path?.includes('/purchase/1001') && rig.posts().length > 0 ? 'timeout' : undefined))],
    ['610', (w) => (w.books['purchase/1001'] = { answer: { status: 400, body: JSON.stringify(fixture('faults/get-deleted.json')) } })],
  ])('the refetch failing (%s): unknown', async (_label, failRefetch) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => (failRefetch(w), { status: 500, body: '{}' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
  });

  it('clear-class unanswered, the refetch moved with line 2 holding no ClassRef: sent-clear-class.json', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-sent.json'] });
    w.post = () => {
      const moved = purchaseMoved();
      moved.Purchase.Line[0].AccountBasedExpenseLineDetail = { AccountRef: { value: '77' } };
      moved.Purchase.Line[1].AccountBasedExpenseLineDetail = { AccountRef: { value: '84' } };
      w.books['purchase/1001'] = moved;
      return { status: 500, body: '{}' };
    };
    const { client } = await w.start();
    expectFile(await client.callTool(args(PURCHASE, toolCall('qbo_categorize_purchase-clear-class').params)), 'qbo_categorize_purchase/sent-clear-class.json');
  });

  it('unknown’s outcome answered not ok: unknown-recorded-none.json', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false, reason: 'failed', cause: 'lock' } }] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown-recorded-none.json');
  });
});

describe('A1.9: another Id', () => {
  const mismatch = () => stored((txn) => (txn.Id = '1009'));
  it('then the refetch moved with the after values: sent-id-mismatch.json, the switch deleted before the refetch', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    let atRefetch: string[] = [];
    w.post = () => ((w.books['purchase/1001'] = purchaseMoved()), mismatch());
    w.onGet = (path) => {
      if (path === 'purchase/1001' && rig.posts().length > 0) atRefetch = readdirSync(w.dir);
    };
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/sent-id-mismatch.json');
    expect(atRefetch).not.toContain('write-enabled');
    expect(w.fake.requests()[1]).toEqual({ ...vector('outcome-sent.json').request, note: 'id-mismatch' });
  });
  it('then unmoved: unknown-id-mismatch.json, outcome-id-mismatch.json’s request as text', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-id-mismatch.json'] });
    w.post = mismatch;
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown-id-mismatch.json');
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('outcome-id-mismatch.json').request));
    expect(readdirSync(w.dir)).not.toContain('write-enabled');
  });
  it('then the refetch moved with a difference: sent-diff with note id-mismatch, the switch deleted once', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => ((w.books['purchase/1001'] = fixture('answers/stored-amount.json').body), mismatch());
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(successWith('qbo_categorize_purchase/sent-id-mismatch.json', { result: 'sent-diff', diff: ['Line:1'] }));
  });
  it('an unmoved id-mismatch whose outcome isn’t recorded: the id-mismatch sentence, with recorded: none', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false } }] });
    w.post = mismatch;
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(errorWith('qbo_categorize_purchase/unknown-id-mismatch.json', 'note', 'recorded: none'));
  });
  it('a stored copy whose two lines share an Id: sent-diff naming Line (contract 1.2)', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stored((txn) => (txn.Line[1].Id = '1'));
    const { client } = await w.start();
    const r = (await client.callTool(args())) as Json;
    expect(JSON.parse(r.content[0].text)).toMatchObject({ result: 'sent-diff', writes_off: true });
    expect(JSON.parse(r.content[0].text).diff).toContain('Line');
  });
});

describe('A1.15: QA4, an update answered 401', () => {
  const NEW = ['qbo', 'fake', 'access', 'token', 'renewed'].join('-');
  const token = (realm_id: string) => ({ status: 200, body: { enterprise: 'garden3d', realm_id, access_token: NEW, expires_at: '2026-11-18T12:00:00Z', company_name: 'garden3d, LLC' } });
  const after401 = () => {
    const i = rig.net.calls.findIndex((c) => c.method === 'POST');
    return rig.net.calls.slice(i + 1);
  };
  const bearer = (c: { headers?: Record<string, unknown> }) => String(Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1]);
  it('no Fault: a forced Stacks fetch, then the refetch with the new token; no QuickBooks request after the 401 holds the old one', async () => {
    rig.tokens.push(NEW);
    const { stacksFake } = await import('../fakes/stacks-token.js');
    rig.stacks = stacksFake({ sequence: ['200-garden3d.json', token(REALMS.garden3d)] });
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 401, body: '' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    const after = after401();
    expect(after.map((c) => c.hostname)).toEqual(['stacks.example.test', 'quickbooks.api.intuit.com']);
    expect(bearer(after[1])).toBe(`Bearer ${NEW}`);
    for (const c of after.filter((x) => x.hostname === 'quickbooks.api.intuit.com')) expect(bearer(c)).not.toContain(fixtureToken('garden3d'));
  });
  it('a forced token for another realm: no refetch, unknown', async () => {
    rig.tokens.push(NEW);
    const { stacksFake } = await import('../fakes/stacks-token.js');
    rig.stacks = stacksFake({ sequence: ['200-garden3d.json', token(REALMS['index-space'])] });
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 401, body: '' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    expect(after401().map((c) => c.hostname)).toEqual(['stacks.example.test']);
  });
  it('a failed forced get (403): no refetch, unknown', async () => {
    const { stacksFake } = await import('../fakes/stacks-token.js');
    rig.stacks = stacksFake({ sequence: ['200-garden3d.json', '403.json'] });
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 401, body: '' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/unknown.json');
    expect(after401().map((c) => c.hostname)).toEqual(['stacks.example.test']);
  });
  it('a 401 with a Fault 6000: failed.json’s form, and the forced get still happened', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-failed.json'] });
    w.post = () => fault('6000', 401, { intuit_tid: 'fake-tid-0002' });
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/failed.json');
    expect(after401().map((c) => c.hostname)).toEqual(['stacks.example.test']);
  });
});

describe('A2.10: the sweep gate, per stamp, at 15:00:00.000Z', () => {
  const STAMPS = fakePath('sweep-stamp');
  const put = (w: World, text: string) => writeFileSync(w.stampPath, text);
  const clean = () => JSON.parse(readFileSync(`${STAMPS}/clean.json`, 'utf8'));
  it.each(['clean.json', 'boundary-20m.json', 'boundary-60s.json'])('%s passes (to the switch, here off)', async (name) => {
    const w = world(rig, OK_SCRIPT, { switchOn: false });
    put(w, readFileSync(`${STAMPS}/${name}`, 'utf8'));
    const { client } = await w.start();
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/disabled.json');
  });
  const refused: Array<[string, (w: World) => void, number | undefined]> = [
    ...['stale.json', 'unclean.json', 'malformed.json', 'negative-jobs.json', 'reason-with-clean.json', 'bad-at.json', 'bad-at-no-millis.json', 'v2.json', 'future.json', 'future-60001ms.json'].map(
      (name): [string, (w: World) => void, undefined] => [name, (w) => put(w, readFileSync(`${STAMPS}/${name}`, 'utf8')), undefined],
    ),
    ['clean.json at 15:11:00.000Z (21 minutes)', () => undefined, Date.parse('2026-11-18T15:11:00.000Z')],
    ['a missing file', (w) => rmSync(w.stampPath), undefined],
    ['a directory at the path', (w) => (rmSync(w.stampPath), mkdirSync(w.stampPath)), undefined],
    ['not JSON', (w) => put(w, '{"v":1,'), undefined],
    ['jobs missing', (w) => put(w, JSON.stringify({ ...clean(), jobs: undefined })), undefined],
    ['an extra key', (w) => put(w, JSON.stringify({ ...clean(), extra: 1 })), undefined],
    ['unclean with no reason', (w) => put(w, JSON.stringify({ ...clean(), clean: false })), undefined],
    ['jobs 1.5', (w) => put(w, JSON.stringify({ ...clean(), jobs: 1.5 })), undefined],
  ];
  it.each(refused)('%s: sweep.json, nothing fetched or asked', async (_label, setup, wall) => {
    const w = world(rig, OK_SCRIPT);
    setup(w);
    const { client } = await w.start(wall === undefined ? {} : { wall: () => wall });
    expectFile(await client.callTool(args()), 'qbo_categorize_purchase/sweep.json');
    expect([rig.net.calls, w.fake.log()]).toEqual([[], []]);
  });
  it('the bill tool too: sweep before the switch', async () => {
    const w = world(rig, OK_SCRIPT, { switchOn: false });
    rmSync(w.stampPath);
    const { client } = await w.start();
    expectFile(await client.callTool(args(BILL)), 'qbo_categorize_purchase/sweep.json');
  });
});

describe('A3.2: the schemas', () => {
  it.each([
    [PURCHASE, 'qbo_categorize_purchase'],
    [PURCHASE, 'qbo_categorize_purchase-clear-class'],
    [BILL, 'qbo_categorize_bill'],
  ])('%s takes %s (no input error), and without params answers the SDK’s input error with nothing fetched or run', async (name, file) => {
    const w = world(rig, OK_SCRIPT, { switchOn: false });
    const { client } = await w.start();
    expectFile(await client.callTool({ name, arguments: toolCall(file) }), 'qbo_categorize_purchase/disabled.json');
    const r = (await client.callTool({ name, arguments: { company: 'garden3d' } })) as Json;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^MCP error -32602/);
    expect([rig.net.calls, w.fake.log()]).toEqual([[], []]);
  });
  it.each([PURCHASE, BILL])('%s: a reason holding U+2028 is the SDK’s input error', async (name) => {
    const w = world(rig, OK_SCRIPT);
    const { client } = await w.start();
    const r = (await client.callTool(args(name, { reason: 'a\u2028b' }))) as Json;
    expect(r.content[0].text).toMatch(/^MCP error -32602/);
    expect([rig.net.calls, w.fake.log()]).toEqual([[], []]);
  });
});

describe('V3', () => {
  it('a first-use companyinfo answering another company’s name: name-mismatch, nothing sent or run', async () => {
    const w = world(rig, OK_SCRIPT);
    (w.books['companyinfo/9990000000000002'] as Json).CompanyInfo = { CompanyName: 'Somebody Else Inc', LegalName: 'Somebody Else Inc' };
    const { client } = await w.start();
    const r = await client.callTool(args());
    expect(readError(r)).toMatchObject({ reason: 'name-mismatch', reported: 'Somebody Else Inc' });
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002']);
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });
  it('an update answer whose intuit_tid fails the pattern: no intuit_tid line', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-failed.json'] });
    w.post = () => fault('6000', 400, { intuit_tid: 'fake tid!' });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual({
      content: [{ type: 'text', text: `reason: write:failed\nreceipt: ${KEY}\ncode: 6000\n\nQuickBooks refused the change.` }],
      isError: true,
    });
    expect((w.fake.requests()[1] as Json).error).toEqual({ code: '6000', intuit_tid: null });
  });
  it('a compare name outside the diff pattern: sent-diff naming it, recorded none (the command refuses the outcome), the switch off', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stored((txn) => (txn['Bad Field!'] = 1));
    const { client } = await w.start();
    const diff = ['Bad Field!'];
    w.fake.malformed({ ...vector('outcome-sent-diff.json').request, diff });
    expect(await client.callTool(args())).toEqual(successWith('qbo_categorize_purchase/sent-diff.json', { diff, recorded: 'none' }));
    expect(w.fake.log()[1].refused).toBe(true);
    expect(readdirSync(w.dir)).not.toContain('write-enabled');
  });
});

describe('the race: two calls on one change', () => {
  it('both built on SyncToken 3, both in flight: one sent, one stale, two intents, one stored change', async () => {
    const K2 = KEY.replace(/1$/, '2');
    const w = world(rig, { intent: ['intent-ok.json', { answer: { ok: true, key: K2, n: 2 } }], outcome: ['outcome-sent.json', 'outcome-stale.json'] });
    let release: () => void = () => undefined;
    const second = new Promise<void>((resolve) => (release = resolve));
    let storedCount = 0;
    let b: Promise<unknown> = Promise.resolve();
    const started = await w.start();
    w.post = async (_c, n) => {
      if (n === 0) {
        b = started.client.callTool(args());
        await second;
        storedCount++;
        return stored();
      }
      release();
      return answerFile('stale.json');
    };
    const a = await started.client.callTool(args());
    expect(a).toEqual(expected('qbo_categorize_purchase/sent.json'));
    expect(await b).toEqual({ content: [{ type: 'text', text: expected('qbo_categorize_purchase/stale.json').content[0].text.replace(KEY, K2) }], isError: true });
    expect(cmds(w).filter((c) => c === 'intent')).toHaveLength(2);
    expect(rig.posts()).toHaveLength(2);
    expect(storedCount).toBe(1);
    const outcomes = w.fake.requests().filter((r: any) => r.cmd === 'outcome') as Json[];
    expect(outcomes.map((o) => [o.key, o.result]).sort()).toEqual([[KEY, 'sent'], [K2, 'stale']]);
  });
});

describe('the rest of A3.3’s list through the server (change.test.ts holds each one’s cases)', () => {
  it.each<[string, Json, Json]>([
    ['qbo_categorize_purchase/sent-ledger-only.json', { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] }, {}],
    ['qbo_categorize_purchase/sent-recorded-none.json', { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false, reason: 'failed', cause: 'ledger' } }] }, {}],
    ['qbo_categorize_purchase/cap.json', { intent: ['intent-cap-intents.json'] }, {}],
    ['qbo_categorize_purchase/receipt-failed-appended.json', { intent: ['intent-receipt-failed.json'] }, {}],
  ])('%s', async (rel, script) => {
    const w = world(rig, script);
    w.post = () => stored();
    const { client } = await w.start();
    expectFile(await client.callTool(args()), rel);
  });
});

afterAll(() => {
  if (nameFiltered()) return;
  const files = ['qbo_categorize_purchase', 'qbo_categorize_bill'].flatMap((dir) => readdirSync(fakePath(`tool-results/${dir}`)).map((f) => `${dir}/${f}`));
  expect(files.filter((f) => !produced.has(f))).toEqual([]);
});
