// Sanctuary Computer (quickbooks-mcp-294): qbo_undo_change through the write server (spec DW2 and DW3; contract 1.2 §18 Undo order, §17
// Settling, §14): exactly the named attempt (A2.1), the settle of a due unknown first and the prepare point (A2.2), the lookup read strictly
// (A2.3), existence only and outside the cap (A2.4), ClassRef cleared (A2.5), the switch never asked (A2.6, task-7-1 M02), each refusal
// (A2.7) and the Undo order between them, the round trip (A2.8), the undo's own receipts (A2.9), the sweep gate (A2.10), the schema (A3.2),
// Q8's texts for undo's own intent, and `recorded` on its results. Each result is compared whole with its tool-results/ file where one
// exists; A3.3's coverage list for qbo_undo_change/ is checked last.
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fakePath } from '../helpers/server.js';
import { nameFiltered } from '../helpers/name-filter.js';
import { stacksFake } from '../fakes/stacks-token.js';
import type { StubCall } from '../fakes/stub-network.js';
import { createKit } from '../../src/write/kit.js';
import { fixture, sharedId, type Json } from './derive.js';
import { vector } from './receipt-fake.js';
import { STAMP_NOW, world, writeRig, type World } from './write-rig.js';

jest.setTimeout(30000);
const rig = writeRig();

const UNDO = 'qbo_undo_change';
/** The undone attempt (lookup-ok.json's: line 1 from 77, no class, to 84 and class 12; sent at SyncToken 3, stored as 4). */
const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
/** The undo's own attempt, on SyncToken 4. */
const NEW = 'quickbooks-write:garden3d:purchase:1001:4:1';
const TIME = '2026-11-18T09:00:00.000-08:00';
const toolCall = (): Json => JSON.parse(readFileSync(fakePath('tool-calls/qbo_undo_change.json'), 'utf8'));
const undo = (receipt = KEY, company = 'garden3d') => ({ name: UNDO, arguments: { ...toolCall(), company, params: { receipt } } });
const expected = (rel: string): Json => JSON.parse(readFileSync(fakePath(`tool-results/${rel}`), 'utf8'));
/** A3.3: each qbo_undo_change/ file some test here compared whole. */
const produced = new Set<string>();
const expectFile = (result: unknown, rel: string): void => {
  expect(result).toEqual(expected(rel));
  if (rel.startsWith(`${UNDO}/`)) produced.add(rel);
};
const errorText = (text: string) => ({ content: [{ type: 'text', text }], isError: true });
/** sent.json with its change item's keys replaced. */
const sentWith = (over: Json): Json => ({ content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(expected(`${UNDO}/sent.json`).content[0].text), ...over }) }] });
const cmds = (w: World): string[] => w.fake.requests().map((r: any) => r.cmd);
const OK = { answer: { ok: true, notion: true } };
const NOT_OK = { answer: { ok: false, reason: 'failed', cause: 'lock' } };
/** §6's two intent texts for receipt-failed (plan Q8), in the receipt-failed.json header form. */
const INTENT_NO_KEY = "reason: write:receipt-failed\n\nThe write receipt couldn't be recorded; nothing was sent.";
const intentKeyText = (key: string) => `reason: write:receipt-failed\nreceipt: ${key}\n\nNotion refused the intent receipt; nothing was sent.`;
const SETTLE_FAILED = "reason: write:receipt-failed\n\nThe settled outcome couldn't be recorded; nothing was sent.";

/** lookup-ok.json's answer, changed by `edit`. */
const lookup = (edit: (a: Json) => void = () => undefined): { answer: Json } => {
  const a = vector('lookup-ok.json').answer;
  edit(a);
  return { answer: a };
};
/** The latest outcome `unknown` at `at`. */
const unknownAt = (at: string) => (a: Json) => (a.outcome = { ...a.outcome, at, result: 'unknown', sync_token_after: null });
/** An intent at `at` with no outcome. */
const intentOnlyAt = (at: string) => (a: Json) => ((a.outcome = null), (a.intent.at = at));
/** 9:59.999 and 10:00.000 old at the world's clock (15:00:00.000Z). */
const WAITS = '2026-11-18T14:50:00.001Z';
const DUE = '2026-11-18T14:50:00.000Z';
const KINDS: Array<[string, (at: string) => (a: Json) => void]> = [
  ['an unknown outcome', unknownAt],
  ['an intent with no outcome', intentOnlyAt],
];

/** Purchase 1001 as the categorize left it (SyncToken 4, line 1 on 84 and class 12), changed by `edit`. */
const afterBook = (edit: (txn: Json) => void = () => undefined): Json => {
  const answer = fixture('fetched/purchase-1001-after.json');
  edit(answer.Purchase);
  return answer;
};
/** QuickBooks storing the update it was sent: the posted body, `sparse` dropped, its SyncToken one up; the books hold it after. */
const storeEcho =
  (w: World, posted: Json[] = []) =>
  (c: StubCall) => {
    const { sparse: _sparse, ...body } = JSON.parse(c.body);
    posted.push(JSON.parse(c.body));
    const txn = { ...body, SyncToken: String(Number(body.SyncToken) + 1), MetaData: { CreateTime: '2026-11-10T09:00:00-08:00' } };
    w.books['purchase/1001'] = { Purchase: txn, time: TIME };
    return { status: 200, body: JSON.stringify({ Purchase: txn, time: TIME }) };
  };
const SENDS = { lookup: [lookup()], intent: ['intent-undo.json'], outcome: [OK] };
/** A world whose books hold the categorized Purchase 1001 and whose QuickBooks stores the undo. */
function undoWorld(script: Json = SENDS, opts: { switchOn?: boolean } = {}): World {
  const w = world(rig, script, opts);
  w.books['purchase/1001'] = afterBook();
  w.post = storeEcho(w);
  return w;
}
const fault610 = () => ({ answer: { status: 400, body: JSON.stringify(fixture('faults/get-missing.json')) } });

describe('A2.1: exactly that attempt', () => {
  const ledger = vector('outcome-sent-after-failed-2.json');
  const K2 = KEY.replace(/1$/, '2');
  const intentOf = (key: string) => ledger.ledger.find((l: Json) => l.kind === 'intent' && l.key === key);
  /** outcome-sent-after-failed-2.json's ledger with its appended `:2` sent: the lookup the command would answer for `key`. */
  const lookupOf = (key: string) => {
    const outcomes = [...ledger.ledger, ...ledger.appended].filter((l: Json) => l.kind === 'outcome' && l.key === key);
    return { answer: { ok: true, intent: intentOf(key), outcome: outcomes.at(-1), superseded_by: null, superseded_ahead: null } };
  };
  it('undo of …:3:2 (its latest outcome sent): sends, sent.json with undo_of …:3:2; the lookup asks exactly that key', async () => {
    const w = undoWorld({ lookup: [lookupOf(K2)], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expect(await client.callTool(undo(K2))).toEqual(sentWith({ undo_of: K2 }));
    expect(JSON.stringify(w.fake.requests()[0])).toBe(JSON.stringify({ cmd: 'lookup', key: K2 }));
    expect((w.fake.requests()[1] as Json).undo_of).toBe(K2);
    expect(rig.posts()).toHaveLength(1);
  });
  it('undo of …:3:1 (its latest outcome failed, though …:3:2 sent): not-sent.json, nothing fetched', async () => {
    const w = undoWorld({ lookup: [lookupOf(KEY)], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo(KEY)), `${UNDO}/not-sent.json`);
    expect(JSON.stringify(w.fake.requests())).toBe(JSON.stringify([{ cmd: 'lookup', key: KEY }]));
    expect(rig.net.calls).toEqual([]);
  });
  it('undo of …:3:2:intent asks the lookup for …:3:2, and the undo’s intent names …:3:2', async () => {
    const w = undoWorld({ lookup: [lookupOf(K2)], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expect(await client.callTool(undo(`${K2}:intent`))).toEqual(sentWith({ undo_of: K2 }));
    expect(JSON.stringify(w.fake.requests()[0])).toBe(JSON.stringify({ cmd: 'lookup', key: K2 }));
    expect((w.fake.requests()[1] as Json).undo_of).toBe(K2);
  });
  it.each([
    ['index-space', 'garden3d'],
    ['garden3d', 'index-space'],
  ])('a key for %s in a %s call: not-sent.json, no lookup, nothing fetched', async (keyCompany, callCompany) => {
    const w = undoWorld();
    const { client } = await w.start();
    expectFile(await client.callTool(undo(KEY.replace('garden3d', keyCompany), callCompany)), `${UNDO}/not-sent.json`);
    expect([w.fake.log(), rig.net.calls]).toEqual([[], []]);
  });
});

describe('A2.2: a due unknown is settled first; the prepare point', () => {
  it.each(KINDS)('%s 9:59.999 old: unknown.json, nothing fetched (no prepare either), no outcome asked', async (_label, kind) => {
    const w = undoWorld({ lookup: [lookup(kind(WAITS))], intent: ['intent-undo.json'], outcome: [OK, OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });

  it.each(KINDS)('%s 10:00.000 old, the refetch showing it stored: settled sent (recorded), then the undo runs and sends', async (_label, kind) => {
    const w = undoWorld({ lookup: [lookup(kind(DUE))], intent: ['intent-undo.json'], outcome: [OK, OK] });
    const { client, runtime } = await w.start();
    const prepare = jest.spyOn(runtime.companies, 'prepareCall');
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    // Prepared once, before the settle's refetch (the first QuickBooks request after the first-use companyinfo), and not again.
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET purchase/1001', 'GET purchase/1001', 'GET preferences', 'GET account/77', 'POST purchase']);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(cmds(w)).toEqual(['lookup', 'outcome', 'intent', 'outcome']);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: KEY, result: 'sent', sync_token_after: '4', diff: null, error: null, note: null }));
    expect(JSON.stringify(w.fake.requests()[2])).toBe(JSON.stringify(vector('intent-undo.json').request));
  });

  it('a settled sent recorded in the ledger only (notion false) is recorded: the undo goes on', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: ['intent-undo.json'], outcome: [{ answer: { ok: true, notion: false } }, OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
  });

  it('settled failed (the refetch unmoved, SyncToken 3): not-sent.json, the failed outcome recorded, nothing sent', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = fixture('fetched/purchase-1001.json');
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: KEY, result: 'failed', sync_token_after: null, diff: null, error: null, note: null }));
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET purchase/1001']);
  });

  it('settled unsettled, deleted (the refetch answers 610): not-sent.json', async () => {
    const w = undoWorld({ lookup: [lookup(intentOnlyAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = fault610();
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect((w.fake.requests()[1] as Json).note).toBe('deleted');
    expect(rig.posts()).toEqual([]);
  });

  it('superseded two ahead (lookup-superseded.json, 30 minutes old): settled unsettled with no refetch and no prepare, not-sent.json, nothing fetched', async () => {
    const w = undoWorld({ lookup: ['lookup-superseded.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: KEY, result: 'unsettled', sync_token_after: null, diff: null, error: null, note: null }));
    expect(rig.net.calls).toEqual([]);
  });

  it('a settle that stays unknown (the refetch answered 500): unknown.json, no outcome asked, nothing sent', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = { answer: { status: 500, body: '{}' } };
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });

  const movedBody = () => JSON.stringify(afterBook());
  it.each<[string, Json]>([
    ['a 500 carrying the moved copy (a status off 2xx)', { answer: { status: 500, body: movedBody() } }],
    ['a 404 carrying the moved copy', { answer: { status: 404, body: movedBody() } }],
    ['a 200 holding another Id', afterBook((t) => (t.Id = '1009'))],
    ['a 200 with no Purchase', { answer: { status: 200, body: JSON.stringify({ Bill: afterBook().Purchase, time: TIME }) } }],
    ['a 200 whose Purchase is no object', { answer: { status: 200, body: JSON.stringify({ Purchase: 'x', time: TIME }) } }],
    ['another Fault (6000)', { answer: { status: 400, body: JSON.stringify({ Fault: { Error: [{ Message: 'm', Detail: 'd', code: '6000' }], type: 'ValidationFault' }, time: TIME }) } }],
  ])('a settle refetch answered %s: no reading, it stays unknown (unknown.json), no outcome asked', async (_label, book) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = book;
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });

  it('the settle’s prepare failing (Stacks 403): unknown.json, nothing asked of QuickBooks', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    rig.stacks = stacksFake({ byKey: { garden3d: '403.json' } });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.qbo()]).toEqual([['lookup'], []]);
  });

  it('the settle’s prepare failing once its token is set (first-use name-mismatch): unknown.json, no refetch, no outcome asked', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    (w.books['companyinfo/9990000000000002'] as Json).CompanyInfo = { CompanyName: 'Somebody Else Inc', LegalName: 'Somebody Else Inc' };
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.qbo()]).toEqual([['lookup'], ['GET companyinfo/9990000000000002']]);
  });

  it('a settled sent-diff whose outcome isn’t recorded: receipt-failed with the settle’s sentence, after the switch file was deleted; nothing sent', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [NOT_OK] });
    w.books['purchase/1001'] = afterBook((txn) => (txn.TotalAmt = 121));
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(SETTLE_FAILED));
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: KEY, result: 'sent-diff', sync_token_after: '4', diff: ['TotalAmt'], error: null, note: null }));
    expect([existsSync(w.switchPath), rig.posts()]).toEqual([false, []]);
  });

  it('a settled failed whose outcome isn’t recorded: receipt-failed with the settle’s sentence (step 4 before step 5)', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [NOT_OK] });
    w.books['purchase/1001'] = fixture('fetched/purchase-1001.json');
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(SETTLE_FAILED));
  });

  it('a settled sent-diff, recorded: the switch file is deleted and the undo still sends (the switch never stops it)', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK, OK] });
    w.books['purchase/1001'] = afterBook((txn) => (txn.TotalAmt = 121));
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect([existsSync(w.switchPath), rig.posts().length]).toEqual([false, 1]);
  });

  it('no settle due (the latest outcome sent), the prepare before step 6 failing (Stacks 403): stacks-auth, 286’s text less (403), nothing fetched', async () => {
    const w = undoWorld();
    rig.stacks = stacksFake({ byKey: { garden3d: '403.json' } });
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(expected('qbo_categorize_purchase/stacks-auth.json'));
    expect([cmds(w), rig.qbo()]).toEqual([['lookup'], []]);
  });

  it('no settle due: the first QuickBooks request is the prepare’s, then step 6’s', async () => {
    const w = undoWorld();
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET purchase/1001', 'GET preferences', 'GET account/77', 'POST purchase']);
  });
});

describe('Q8: the undo’s own intent answered not ok (A2.2), nothing sent', () => {
  const answered = (answer: unknown) => ({ lookup: [lookup()], intent: [{ answer }], outcome: [OK] });
  it.each<[string, unknown, string]>([
    ['with no key', { ok: false, reason: 'write:receipt-failed', cause: 'lock' }, INTENT_NO_KEY],
    ['with this call’s key (intent-receipt-failed.json’s answer, its key …:4:1)', { ...vector('intent-receipt-failed.json').answer, key: NEW }, intentKeyText(NEW)],
    ['with a key for another attempt (the undone one)', { ...vector('intent-receipt-failed.json').answer, key: KEY }, INTENT_NO_KEY],
    ['write:cap (intent-cap-intents.json): never the cap for undo, the no-key text', vector('intent-cap-intents.json').answer, INTENT_NO_KEY],
  ])('%s', async (_label, answer, text) => {
    const w = undoWorld(answered(answer));
    const { client, mode } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(text));
    expect([cmds(w), rig.posts(), mode.registry.size]).toEqual([['lookup', 'intent'], [], 0]);
  });
});

describe('A2.3: the lookup read strictly; each receipt-failed.json with nothing fetched', () => {
  const malformed: Array<[string, (a: Json) => void]> = [
    ['ok "true"', (a) => (a.ok = 'true')],
    ['ok 1', (a) => (a.ok = 1)],
    ['an intent whose key isn’t the asked one', (a) => (a.intent.key = KEY.replace(/1$/, '2'))],
    ['an intent whose company isn’t the key’s', (a) => (a.intent.company = 'index-space')],
    ['an intent whose type isn’t the key’s', (a) => (a.intent.type = 'bill')],
    ['an intent whose id isn’t the key’s', (a) => (a.intent.id = '1002')],
    ['an intent whose sync_token isn’t the key’s', (a) => (a.intent.sync_token = '4')],
    ['an intent missing reason', (a) => delete a.intent.reason],
    ['an intent with no lines', (a) => (a.intent.lines = [])],
    ['an intent whose at fails the round trip', (a) => (a.intent.at = '2026-11-18T14:00:00Z')],
    ['an outcome of another key', (a) => (a.outcome.key = KEY.replace(/1$/, '2'))],
    ['an outcome missing note', (a) => delete a.outcome.note],
    ['an outcome with result "maybe"', (a) => (a.outcome.result = 'maybe')],
    ['superseded_by that isn’t an attempt key', (a) => ((a.superseded_by = 'x'), (a.superseded_ahead = 2))],
    ['superseded_ahead -1', (a) => ((a.superseded_by = KEY.replace(':3:', ':5:')), (a.superseded_ahead = -1))],
    ['superseded_ahead 1.5', (a) => ((a.superseded_by = KEY.replace(':3:', ':5:')), (a.superseded_ahead = 1.5))],
    ['superseded_by set, superseded_ahead null', (a) => (a.superseded_by = KEY.replace(':3:', ':5:'))],
    ['superseded_by null, superseded_ahead 0', (a) => (a.superseded_ahead = 0)],
    ['an extra key', (a) => (a.extra = true)],
    ['ok true, reason not-found (not a not-ok answer)', (a) => ((a.reason = 'not-found'), delete a.intent)],
  ];
  it.each(malformed)('%s', async (_label, edit) => {
    const w = undoWorld({ lookup: [lookup(edit)], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/receipt-failed.json`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });
  it.each<[string, unknown]>([
    ['failed with a cause (lookup-lock-busy.json)', 'lookup-lock-busy.json'],
    ['bad-request (bad-request.json)', 'bad-request.json'],
    ['exit 1', { misbehave: 'exit 1' }],
    ['no JSON', { misbehave: 'no-json' }],
    ['not-found with ok "false"', { answer: { ok: 'false', reason: 'not-found', cause: 'not-found' } }],
  ])('a not-ok lookup other than not-found, %s: receipt-failed.json', async (_label, step) => {
    const w = undoWorld({ lookup: [step as any] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/receipt-failed.json`);
    expect(rig.net.calls).toEqual([]);
  });
});

describe('A2.4: existence only; outside the cap', () => {
  it('cases/undo-to-asset.json: back to 30 (Other Current Asset), sent as its sparse_body', async () => {
    const asset = fixture('cases/undo-to-asset.json');
    const names = { '30': 'Uncategorized Asset', '84': 'Software' };
    const side = (s: Json) => ({ account_id: s.account_id, account_name: names[s.account_id as '30' | '84'], class_id: null, class_name: null });
    const answer = lookup((a) => {
      a.intent = { ...a.intent, key: asset.intent.key, id: '1005', sync_token: '0', digests: asset.digests };
      a.intent.lines = asset.intent.lines.map((l: Json) => ({ line_id: l.line_id, before: side(l.before), after: side(l.after) }));
      a.outcome = { ...a.outcome, key: asset.intent.key, sync_token_after: '1' };
    });
    const key = 'quickbooks-write:garden3d:purchase:1005:1:1';
    const w = world(rig, { lookup: [answer], intent: [{ answer: { ok: true, key, n: 1 } }], outcome: [OK] });
    w.books['purchase/1005'] = fixture('fetched/purchase-1005-asset-after.json');
    w.post = (c) => {
      const { sparse: _s, ...body } = JSON.parse(c.body);
      return { status: 200, body: JSON.stringify({ Purchase: { ...body, SyncToken: '2' }, time: TIME }) };
    };
    const { client } = await w.start();
    const r: any = await client.callTool(undo(asset.intent.key));
    expect(JSON.parse(r.content[0].text)).toMatchObject({ result: 'sent', receipt: key, lines: [{ line_id: '1', before: { account_id: '84', class_id: null }, after: { account_id: '30', class_id: null } }] });
    expect(rig.posts()[0].body).toBe(JSON.stringify(asset.sparse_body));
  });

  it('a before class that is inactive (derived: class 19): sent, its ClassRef put back', async () => {
    const answer = lookup((a) => ((a.intent.lines[0].before.class_id = '19'), (a.intent.lines[0].before.class_name = 'Old')));
    const w = undoWorld({ lookup: [answer], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] });
    const { client } = await w.start();
    const r: any = await client.callTool(undo());
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(rig.posts()[0].body).Line[0].AccountBasedExpenseLineDetail).toEqual({ AccountRef: { value: '77' }, ClassRef: { value: '19' } });
    expect(rig.qbo()).toContain('GET class/19');
  });

  it('the undo’s intent is, as text, intent-undo.json’s request (names swapped, undo_of set), and the fake answers it as after a full cap', async () => {
    const w = undoWorld({ lookup: [lookup()], intent: ['intent-cap-undo-passes.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('intent-undo.json').request));
    expect(JSON.stringify(vector('intent-cap-undo-passes.json').request)).toBe(JSON.stringify(vector('intent-undo.json').request));
  });
});

describe('A2.5: ClassRef cleared', () => {
  it('undo of qbo_categorize_purchase.json’s change: the POST’s bodyText is cases/undo.json’s sparse_body (no ClassRef on line 1); sent.json', async () => {
    const w = undoWorld();
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(rig.posts().map((c) => c.body)).toEqual([JSON.stringify(fixture('cases/undo.json').sparse_body)]);
  });
});

describe('A2.6: the switch never asked (task-7-1 M02)', () => {
  it('the switch file absent, a clean stamp: undo sends sent.json, categorize in the same server disabled.json; undo never stats the switch', async () => {
    const w = undoWorld(SENDS, { switchOn: false });
    const real = createKit().fs;
    const stat = jest.fn(real.stat);
    const { client } = await w.start({ fs: { stat: stat as unknown as typeof real.stat, unlink: real.unlink } });
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(stat).not.toHaveBeenCalled();
    const call = JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8'));
    expectFile(await client.callTool({ name: 'qbo_categorize_purchase', arguments: call }), 'qbo_categorize_purchase/disabled.json');
    expect(stat).toHaveBeenCalled();
    expect(rig.posts()).toHaveLength(1);
  });

  it('the switch deleted after the fetches, before the undo’s intent (categorize’s S16 window): undo still sends', async () => {
    const w = undoWorld();
    w.onGet = (path) => {
      if (path === 'account/77') rmSync(w.switchPath, { force: true });
    };
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
  });
});

describe('A2.7: each refusal, nothing sent', () => {
  const failedOutcome = { result: 'failed', error: { code: '6000', intuit_tid: 'fake-tid-0002' } };
  it.each<[string, Json]>([
    ['failed', failedOutcome],
    ['stale', { result: 'stale' }],
    ['refused', { result: 'refused' }],
    ['unsettled', { result: 'unsettled' }],
  ])('the latest outcome %s: not-sent.json, nothing fetched', async (_label, over) => {
    const w = undoWorld({ lookup: [lookup((a) => (a.outcome = { ...a.outcome, sync_token_after: null, ...over }))] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });

  it('the latest outcome sent-diff: undone (sends)', async () => {
    const w = undoWorld({ lookup: [lookup((a) => (a.outcome = { ...a.outcome, result: 'sent-diff', diff: ['TotalAmt'] }))], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
  });

  it('lookup not-found (lookup-not-found.json): not-sent.json, nothing fetched', async () => {
    const w = undoWorld({ lookup: ['lookup-not-found.json'] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect(rig.net.calls).toEqual([]);
  });

  it('the receipt’s intent has undo_of set: undo-of-undo.json, nothing fetched', async () => {
    const w = undoWorld({ lookup: [lookup((a) => (a.intent.undo_of = KEY.replace(':3:', ':2:')))] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/undo-of-undo.json`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });

  const afterFetch: Array<[string, (w: World) => void, string]> = [
    ['line 1 back on 77 (fetched/purchase-1001.json as the transaction): changed-since.json', (w) => (w.books['purchase/1001'] = fixture('fetched/purchase-1001.json')), `${UNDO}/changed-since.json`],
    ['line 1 on the after account but no class: changed-since.json', (w) => (w.books['purchase/1001'] = afterBook((t) => delete t.Line[0].AccountBasedExpenseLineDetail.ClassRef)), `${UNDO}/changed-since.json`],
    ['line 1 on the after class but account 91: changed-since.json', (w) => (w.books['purchase/1001'] = afterBook((t) => (t.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '91'))), `${UNDO}/changed-since.json`],
    ['line 1 gone: changed-since.json', (w) => (w.books['purchase/1001'] = afterBook((t) => t.Line.shift())), `${UNDO}/changed-since.json`],
    ['books closed since (BookCloseDate 2026-11-10, the TxnDate): closed.json', (w) => ((w.books.preferences as Json).Preferences.AccountingInfoPrefs.BookCloseDate = '2026-11-10'), `${UNDO}/closed.json`],
    ['the transaction answers 610: not-found.json', (w) => (w.books['purchase/1001'] = fault610()), `${UNDO}/not-found.json`],
    ['before account 77 answers 610: account.json', (w) => (w.books['account/77'] = fault610()), `${UNDO}/account.json`],
  ];
  it.each(afterFetch)('%s', async (_label, setup, rel) => {
    const w = undoWorld();
    setup(w);
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), rel);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });

  it('before class 12 answers 610 (an undo of a class clear on line 2): class.json', async () => {
    const answer = lookup((a) => {
      a.intent.lines = [
        {
          line_id: '2',
          before: { account_id: '84', account_name: 'Software', class_id: '12', class_name: 'Client Delivery' },
          after: { account_id: '84', account_name: 'Software', class_id: null, class_name: null },
        },
      ];
    });
    const w = undoWorld({ lookup: [answer] });
    w.books['purchase/1001'] = afterBook((t) => delete t.Line[1].AccountBasedExpenseLineDetail.ClassRef);
    w.books['class/12'] = fault610();
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/class.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });

  it('lookup not ok (lookup-lock-busy.json): receipt-failed.json', async () => {
    const w = undoWorld({ lookup: ['lookup-lock-busy.json'] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/receipt-failed.json`);
  });
});

describe('the Undo order: the first failing step answers, nothing after it runs', () => {
  it('step 1 before step 2: a stale stamp answers sweep.json with no lookup', async () => {
    const w = undoWorld();
    rmSync(w.stampPath);
    const { client } = await w.start();
    expectFile(await client.callTool(undo(KEY, 'index-space')), `${UNDO}/sweep.json`);
    expect([w.fake.log(), rig.net.calls]).toEqual([[], []]);
  });
  it('step 3 before step 4: an undo whose unknown is due answers undo-of-undo.json with no settle', async () => {
    const w = undoWorld({ lookup: [lookup((a) => (unknownAt(DUE)(a), (a.intent.undo_of = KEY.replace(':3:', ':2:'))))], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/undo-of-undo.json`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });
  it('step 3 before step 5: an undo whose latest outcome failed answers undo-of-undo.json', async () => {
    const w = undoWorld({ lookup: [lookup((a) => ((a.intent.undo_of = KEY.replace(':3:', ':2:')), (a.outcome = { ...a.outcome, result: 'failed', sync_token_after: null })))] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/undo-of-undo.json`);
  });
  it.each<[string, (w: World) => void, Json]>([
    ['step 7 (closed) before step 9 (changed-since)', (w) => ((w.books['purchase/1001'] = fixture('fetched/purchase-1001.json')), ((w.books.preferences as Json).Preferences.AccountingInfoPrefs.BookCloseDate = '2026-11-10')), expected(`${UNDO}/closed.json`)],
    [
      'step 7 (type: a credit) before step 9',
      (w) => {
        const changed = fixture('fetched/purchase-1001.json');
        changed.Purchase.Credit = true;
        w.books['purchase/1001'] = changed;
      },
      expected('qbo_categorize_purchase/type.json'),
    ],
    [
      'step 8 (line ids) before step 9',
      (w) => (w.books['purchase/1001'] = sharedId(fixture('fetched/purchase-1001.json'))),
      errorText("reason: write:line\n\nA line of this transaction has no Id or shares one, so it can't be re-sent safely."),
    ],
    ['step 9 (changed-since) before step 10 (account)', (w) => ((w.books['purchase/1001'] = fixture('fetched/purchase-1001.json')), (w.books['account/77'] = fault610())), expected(`${UNDO}/changed-since.json`)],
    ['step 10 (account) before step 11 (class)', (w) => ((w.books['account/77'] = fault610()), (w.books['class/19'] = fault610())), expected(`${UNDO}/account.json`)],
  ])('%s', async (_label, setup, want) => {
    const answer = lookup((a) => (a.intent.lines[0].before.class_id = '19'));
    const w = undoWorld({ lookup: [answer] });
    setup(w);
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(want);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
  it('step 12 (diff, through the test seam deps.buildBody) before step 13: diff, no intent, nothing sent', async () => {
    const w = undoWorld();
    const { client } = await w.start({ buildBody: (fetched, changes) => ({ ...createKit().buildBody(fetched, changes), TotalAmt: 1 }) });
    expect(await client.callTool(undo())).toEqual(expected('qbo_categorize_purchase/diff.json'));
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
});

describe('A2.8: a change then its undo restores', () => {
  const categorize = () => ({ name: 'qbo_categorize_purchase', arguments: JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8')) });
  it('one server: categorize (sent), then undo its receipt: the second POST’s line 1 refs are the first’s fetched ones; the books’ line 1 is the original', async () => {
    const original = fixture('fetched/purchase-1001.json').Purchase;
    const w = world(rig, { intent: ['intent-ok.json', 'intent-undo.json'], lookup: [lookup()], outcome: [OK, OK] });
    const posted: Json[] = [];
    w.post = storeEcho(w, posted);
    const { client } = await w.start();
    expectFile(await client.callTool(categorize()), 'qbo_categorize_purchase/sent.json');
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(posted).toHaveLength(2);
    expect(posted[1].Line[0].AccountBasedExpenseLineDetail).toEqual(original.Line[0].AccountBasedExpenseLineDetail);
    expect((w.books['purchase/1001'] as Json).Purchase.Line).toEqual(original.Line);
  });
  it('with an edit between (the books’ line 1 set to account 91): changed-since.json, one POST', async () => {
    const w = world(rig, { intent: ['intent-ok.json', 'intent-undo.json'], lookup: [lookup()], outcome: [OK, OK] });
    w.post = storeEcho(w);
    const { client } = await w.start();
    expectFile(await client.callTool(categorize()), 'qbo_categorize_purchase/sent.json');
    (w.books['purchase/1001'] as Json).Purchase.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '91';
    expectFile(await client.callTool(undo()), `${UNDO}/changed-since.json`);
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('A2.9: the undo’s receipts', () => {
  it('its intent: undo_of the undone key, reason the undone intent’s; its result: undo_of that key, receipt its own …:4:1', async () => {
    const reason = 'Moved to software by mistake.';
    const w = undoWorld({ lookup: [lookup((a) => (a.intent.reason = reason))], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] });
    const { client } = await w.start();
    const r: any = await client.callTool(undo(`${KEY}:intent`));
    expect(JSON.parse(r.content[0].text)).toMatchObject({ receipt: NEW, undo_of: KEY });
    expect(w.fake.requests()[1]).toMatchObject({ cmd: 'intent', undo_of: KEY, reason });
    expect((w.fake.requests()[2] as Json).key).toBe(NEW);
  });
});

describe('recorded on every result, one send', () => {
  it.each<[string, unknown, Json]>([
    ['ledger', { ok: true, notion: false }, sentWith({ recorded: 'ledger' })],
    ['none', { ok: false, reason: 'failed', cause: 'lock' }, sentWith({ recorded: 'none' })],
  ])('a sent undo whose outcome is recorded %s', async (_label, answer, want) => {
    const w = undoWorld({ lookup: [lookup()], intent: ['intent-undo.json'], outcome: [{ answer }] });
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(want);
    expect(rig.posts()).toHaveLength(1);
  });
  it('a stale undo (Fault 5010): write:stale with its own receipt, the stale outcome, one POST', async () => {
    const w = undoWorld({ lookup: [lookup()], intent: ['intent-undo.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => ({ status: 400, body: JSON.stringify({ Fault: { Error: [{ Message: 'm', Detail: 'd', code: '5010' }], type: 'ValidationFault' }, time: TIME }) });
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:stale\nreceipt: ${NEW}\nrecorded: ledger\n\nSomeone edited the transaction meanwhile; nothing was overwritten.`));
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: NEW, result: 'stale' });
    expect(rig.posts()).toHaveLength(1);
  });
  it('an unanswered undo, the refetch unmoved: write:unknown with its own receipt, never sent again', async () => {
    const w = undoWorld({ lookup: [lookup()], intent: ['intent-undo.json'], outcome: [OK] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(rig.qbo().slice(-2)).toEqual(['POST purchase', 'GET purchase/1001']);
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('A2.10: the sweep gate for undo, per stamp, at 15:00:00.000Z', () => {
  const STAMPS = fakePath('sweep-stamp');
  const put = (w: World, text: string) => writeFileSync(w.stampPath, text);
  const clean = () => JSON.parse(readFileSync(`${STAMPS}/clean.json`, 'utf8'));
  it.each(['clean.json', 'boundary-20m.json', 'boundary-60s.json'])('%s passes (to the lookup, here not-found)', async (name) => {
    const w = undoWorld({ lookup: ['lookup-not-found.json'] });
    put(w, readFileSync(`${STAMPS}/${name}`, 'utf8'));
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect(cmds(w)).toEqual(['lookup']);
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
    const w = undoWorld();
    setup(w);
    const { client } = await w.start(wall === undefined ? {} : { wall: () => wall });
    expectFile(await client.callTool(undo()), `${UNDO}/sweep.json`);
    expect([rig.net.calls, w.fake.log()]).toEqual([[], []]);
  });
  it('the switch absent and a clean stamp still sends (A2.6)', async () => {
    const w = undoWorld(SENDS, { switchOn: false });
    const { client } = await w.start({ wall: () => STAMP_NOW });
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
  });
});

describe('A3.2: the schema', () => {
  it('takes tool-calls/qbo_undo_change.json (no input error); without params, the SDK’s input error with nothing fetched or run', async () => {
    const w = undoWorld({ lookup: ['lookup-not-found.json'] });
    const { client } = await w.start();
    expectFile(await client.callTool({ name: UNDO, arguments: toolCall() }), `${UNDO}/not-sent.json`);
    rig.net.calls.length = 0;
    const r = (await client.callTool({ name: UNDO, arguments: { company: 'garden3d' } })) as Json;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^MCP error -32602/);
    expect([rig.net.calls, cmds(w)]).toEqual([[], ['lookup']]);
  });
});

afterAll(() => {
  if (nameFiltered()) return;
  const files = readdirSync(fakePath(`tool-results/${UNDO}`)).map((f) => `${UNDO}/${f}`);
  expect(files.filter((f) => !produced.has(f))).toEqual([]);
});
