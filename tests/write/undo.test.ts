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
import { forkReason } from '../../src/write/results.js';
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
    expect(await client.callTool(undo())).toEqual(errorText(`${SETTLE_FAILED} Writes are switched off.`));
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: KEY, result: 'sent-diff', sync_token_after: '4', diff: ['TotalAmt'], error: null, note: null }));
    expect([existsSync(w.switchPath), rig.posts()]).toEqual([false, []]);
  });

  it('a settled failed whose outcome isn’t recorded: receipt-failed with the settle’s sentence (step 4 before step 5)', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [NOT_OK] });
    w.books['purchase/1001'] = fixture('fetched/purchase-1001.json');
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(SETTLE_FAILED));
  });

  it('a settled sent-diff, recorded: the switch file is deleted and the undo still sends (the switch never stops it): sent.json, writes_off false, then the sentence', async () => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK, OK] });
    w.books['purchase/1001'] = afterBook((txn) => (txn.TotalAmt = 121));
    const { client } = await w.start();
    // task-9-1 TR1: writes_off is this attempt's own deletion (§14); the settle's is told after the data item.
    expect(await client.callTool(undo())).toEqual({ content: [...expected(`${UNDO}/sent.json`).content, { type: 'text', text: 'WARNING: Writes are switched off.' }] });
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

describe('task-8-1 TM1: an undo of a change that names two lines (§18 step 9, "every line")', () => {
  /** The undone change named line 1 (77, no class, to 84 and class 12) and line 2 (91, no class, to 84 and class 12). */
  const LINE_2 = {
    line_id: '2',
    before: { account_id: '91', account_name: 'Contractors', class_id: null, class_name: null },
    after: { account_id: '84', account_name: 'Software', class_id: '12', class_name: 'Client Delivery' },
  };
  const twoLines = () => lookup((a) => a.intent.lines.push(LINE_2));
  const script = () => ({ lookup: [twoLines()], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] });
  const detail = (account: string) => ({ AccountRef: { value: account } });
  const put = (line: string, account: string) => ({ line_id: line, before: { account_id: '84', class_id: '12' }, after: { account_id: account, class_id: null } });

  it('both lines still on the after values: sent, each line’s before values put back (no ClassRef), the books hold both', async () => {
    const w = undoWorld(script());
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(sentWith({ lines: [put('1', '77'), put('2', '91')] }));
    expect(JSON.parse(rig.posts()[0].body).Line.map((l: Json) => [l.Id, l.AccountBasedExpenseLineDetail])).toEqual([
      ['1', detail('77')],
      ['2', detail('91')],
    ]);
    expect((w.books['purchase/1001'] as Json).Purchase.Line.map((l: Json) => l.AccountBasedExpenseLineDetail)).toEqual([detail('77'), detail('91')]);
    expect(JSON.parse(JSON.stringify(w.fake.requests()[1])).lines).toEqual([
      { line_id: '1', before: vector('intent-undo.json').request.lines[0].before, after: vector('intent-undo.json').request.lines[0].after },
      { line_id: '2', before: LINE_2.after, after: LINE_2.before },
    ]);
  });

  const edits: Array<[string, (t: Json) => void]> = [
    ['only line 1 on another account (92)', (t) => (t.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '92')],
    ['only line 1’s class cleared', (t) => delete t.Line[0].AccountBasedExpenseLineDetail.ClassRef],
    ['only line 1 gone', (t) => t.Line.shift()],
    ['only line 2 on another account (92)', (t) => (t.Line[1].AccountBasedExpenseLineDetail.AccountRef.value = '92')],
    ['only line 2 on another class (13)', (t) => (t.Line[1].AccountBasedExpenseLineDetail.ClassRef.value = '13')],
    ['only line 2’s class cleared', (t) => delete t.Line[1].AccountBasedExpenseLineDetail.ClassRef],
    ['only line 2 gone', (t) => t.Line.pop()],
  ];
  it.each(edits)('%s since: changed-since.json, no intent, nothing sent', async (_label, edit) => {
    const w = undoWorld(script());
    w.books['purchase/1001'] = afterBook(edit);
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/changed-since.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });

  // Step 6 after the undo's own send (change.ts's holdsAfter): moved, but only one of the two lines put back, is no stored copy.
  it.each<[string, number]>([
    ['line 1 put back, line 2 still on 84', 0],
    ['line 2 put back, line 1 still on 84', 1],
  ])('no answer, the refetch moved with %s: write:unknown with its own receipt, never sent again', async (_label, back) => {
    const w = undoWorld(script());
    w.post = () => {
      w.books['purchase/1001'] = afterBook((t) => {
        t.SyncToken = '5';
        t.Line[back].AccountBasedExpenseLineDetail = detail(back === 0 ? '77' : '91');
      });
      return { status: 500, body: '{}' };
    };
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: NEW, result: 'unknown' });
    expect(rig.posts()).toHaveLength(1);
  });
  it('no answer, the refetch moved with both lines put back: sent (stored), one POST', async () => {
    const w = undoWorld(script());
    w.post = () => {
      w.books['purchase/1001'] = afterBook((t) => ((t.SyncToken = '5'), (t.Line[0].AccountBasedExpenseLineDetail = detail('77')), (t.Line[1].AccountBasedExpenseLineDetail = detail('91'))));
      return { status: 500, body: '{}' };
    };
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(sentWith({ lines: [put('1', '77'), put('2', '91')] }));
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('task-8-1 TM2: an undo of a Bill’s change (§13 purchase or bill; §18 steps 4, 6, 7)', () => {
  /** qbo_categorize_bill.json's change (intent-bill.json: bill 2001 line 1 from 77 to 91, sent at SyncToken 0, stored as 1). */
  const BKEY = 'quickbooks-write:garden3d:bill:2001:0:1';
  const BNEW = 'quickbooks-write:garden3d:bill:2001:1:1';
  const billLookup = (id = '2001', edit: (a: Json) => void = () => undefined) =>
    lookup((a) => {
      const req = vector('intent-bill.json').request;
      const key = `quickbooks-write:garden3d:bill:${id}:0:1`;
      a.intent = { ...a.intent, key, type: 'bill', id, sync_token: '0', lines: req.lines, digests: req.digests, reason: req.reason };
      a.outcome = { ...a.outcome, key, sync_token_after: '1' };
      edit(a);
    });
  /** A bill as the categorize left it: SyncToken 1, line 1 on 91. */
  const billAfter = (file: string): Json => {
    const answer = fixture(file);
    answer.Bill.SyncToken = '1';
    answer.Bill.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '91';
    return answer;
  };
  /** QuickBooks storing the Bill update it was sent, one SyncToken up; the books hold it after. */
  const billEcho = (w: World) => (c: StubCall) => {
    const { sparse: _sparse, ...body } = JSON.parse(c.body);
    const txn = { ...body, SyncToken: String(Number(body.SyncToken) + 1), MetaData: { CreateTime: '2026-11-12T09:00:00-08:00' } };
    w.books['bill/2001'] = { Bill: txn, time: TIME };
    return { status: 200, body: JSON.stringify({ Bill: txn, time: TIME }) };
  };
  const billWorld = (lk: { answer: Json }, outcomes: Array<typeof OK> = [OK]): World => {
    const w = world(rig, { lookup: [lk], intent: [{ answer: { ok: true, key: BNEW, n: 1 } }], outcome: outcomes });
    w.books['bill/2001'] = billAfter('fetched/bill-2001.json');
    w.post = billEcho(w);
    return w;
  };
  const billSent = sentWith({
    receipt: BNEW,
    type: 'bill',
    id: '2001',
    sync_token: '1',
    sync_token_after: '2',
    lines: [{ line_id: '1', before: { account_id: '91', class_id: null }, after: { account_id: '77', class_id: null } }],
    undo_of: BKEY,
  });
  /** The logged intent request (the `n`th command run), less its digests. */
  const intentRequest = (w: World, n = 1): Json => {
    const { digests: _d, ...rest } = w.fake.requests()[n] as Json;
    return rest;
  };
  const wantIntent = {
    cmd: 'intent',
    company: 'garden3d',
    type: 'bill',
    id: '2001',
    sync_token: '1',
    lines: [{ line_id: '1', before: vector('intent-bill.json').request.lines[0].after, after: vector('intent-bill.json').request.lines[0].before }],
    reason: vector('intent-bill.json').request.reason,
    undo_of: BKEY,
  };

  it('its latest outcome sent: the GET and the POST on bill, the intent’s type bill; sent with its own bill receipt; the books’ line 1 back on 77', async () => {
    const w = billWorld(billLookup());
    const { client } = await w.start();
    expect(await client.callTool(undo(BKEY))).toEqual(billSent);
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET bill/2001', 'GET preferences', 'GET account/77', 'POST bill']);
    expect(intentRequest(w)).toEqual(wantIntent);
    expect((w.books['bill/2001'] as Json).Bill.Line[0].AccountBasedExpenseLineDetail).toEqual({ AccountRef: { value: '77' } });
  });

  it.each(KINDS)('%s 10:00.000 old: settled sent from bill/2001 (its Bill read), then the undo sends on bill', async (_label, kind) => {
    const w = billWorld(billLookup('2001', kind(DUE)), [OK, OK]);
    const { client } = await w.start();
    expect(await client.callTool(undo(BKEY))).toEqual(billSent);
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET bill/2001', 'GET bill/2001', 'GET preferences', 'GET account/77', 'POST bill']);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify({ cmd: 'outcome', key: BKEY, result: 'sent', sync_token_after: '1', diff: null, error: null, note: null }));
    expect(intentRequest(w, 2)).toEqual(wantIntent);
  });

  it('a due unknown, bill/2001 unmoved (SyncToken 0): settled failed from the Bill, not-sent.json, nothing sent', async () => {
    const w = billWorld(billLookup('2001', unknownAt(DUE)));
    w.books['bill/2001'] = fixture('fetched/bill-2001.json');
    const { client } = await w.start();
    expectFile(await client.callTool(undo(BKEY)), `${UNDO}/not-sent.json`);
    expect(w.fake.requests()[1]).toMatchObject({ cmd: 'outcome', key: BKEY, result: 'failed' });
    expect(rig.qbo()).toEqual(['GET companyinfo/9990000000000002', 'GET bill/2001']);
  });

  it.each<[string, string, string]>([
    ['a Stacks bill (bill 2002, DocNumber Stacks_…)', '2002', 'fetched/bill-2002-stacks.json'],
    ['an intercompany bill (bill 2003)', '2003', 'fetched/bill-2003-intercompany.json'],
  ])('%s: write:stacks-bill through undo, as categorize answers it; nothing sent', async (_label, id, file) => {
    const w = billWorld(billLookup(id));
    w.books[`bill/${id}`] = billAfter(file);
    const { client } = await w.start();
    expect(await client.callTool(undo(`quickbooks-write:garden3d:bill:${id}:0:1`))).toEqual(
      expected(`qbo_categorize_bill/${id === '2002' ? 'stacks-bill.json' : 'stacks-bill-intercompany.json'}`),
    );
    expect([cmds(w), rig.posts(), rig.qbo()]).toEqual([['lookup'], [], ['GET companyinfo/9990000000000002', `GET bill/${id}`, 'GET preferences']]);
  });

  it('no answer, bill/2001 unmoved: write:unknown with its own bill receipt; the refetch is on bill, never sent again', async () => {
    const w = billWorld(billLookup());
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(undo(BKEY))).toEqual(errorText(`reason: write:unknown\nreceipt: ${BNEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(rig.qbo().slice(-2)).toEqual(['POST bill', 'GET bill/2001']);
  });

  // task-8-2 TN2: step 6's refetch and the settle's are read under the entity sent (`Bill`), never under `Purchase`.
  /** bill/2001 as the undo left it: SyncToken 2, line 1 back on 77. */
  const billPutBack = (): Json => {
    const answer = billAfter('fetched/bill-2001.json');
    answer.Bill.SyncToken = '2';
    answer.Bill.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '77';
    return answer;
  };
  it('task-8-2 TN2: no answer, bill/2001 refetched moved with line 1 back on 77: sent (stored from the refetched Bill), one POST', async () => {
    const w = billWorld(billLookup());
    w.post = () => ((w.books['bill/2001'] = billPutBack()), { status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(undo(BKEY))).toEqual(billSent);
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: BNEW, result: 'sent', sync_token_after: '2' });
    expect(rig.posts()).toHaveLength(1);
  });
  it('task-8-2 TN2: no answer, bill/2001’s refetch holding that copy under Purchase: write:unknown with its own bill receipt', async () => {
    const w = billWorld(billLookup());
    w.post = () => ((w.books['bill/2001'] = { Purchase: billPutBack().Bill, time: TIME }), { status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(undo(BKEY))).toEqual(errorText(`reason: write:unknown\nreceipt: ${BNEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: BNEW, result: 'unknown' });
    expect(rig.posts()).toHaveLength(1);
  });
  it('task-8-2 TN2: a due unknown, bill/2001’s refetch holding the moved copy under Purchase: it stays unknown (unknown.json), no outcome asked', async () => {
    const w = billWorld(billLookup('2001', unknownAt(DUE)));
    w.books['bill/2001'] = { Purchase: billAfter('fetched/bill-2001.json').Bill, time: TIME };
    const { client } = await w.start();
    expectFile(await client.callTool(undo(BKEY)), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
});

describe('task-8-1 TM3: step 2’s not-found is the reason, not the cause', () => {
  it.each<[string, Json, string]>([
    ['reason failed, cause not-found: receipt-failed.json', { ok: false, reason: 'failed', cause: 'not-found' }, 'receipt-failed.json'],
    ['reason bad-request, cause not-found: receipt-failed.json', { ok: false, reason: 'bad-request', cause: 'not-found' }, 'receipt-failed.json'],
    ['no reason, cause not-found: receipt-failed.json', { ok: false, cause: 'not-found' }, 'receipt-failed.json'],
    ['reason not-found, cause lock: not-sent.json', { ok: false, reason: 'not-found', cause: 'lock' }, 'not-sent.json'],
    ['reason not-found, no cause: not-sent.json', { ok: false, reason: 'not-found' }, 'not-sent.json'],
  ])('a not-ok lookup, %s, nothing fetched', async (_label, answer, rel) => {
    const w = undoWorld({ lookup: [{ answer }] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/${rel}`);
    expect([cmds(w), rig.net.calls]).toEqual([['lookup'], []]);
  });
});

describe('task-8-1 TM4: the settle’s refetch reads a Fault from its first Error item, in any status (§17)', () => {
  const fault = (status: number, codes: string[], extra: Json = {}) => ({
    answer: { status, body: JSON.stringify({ Fault: { Error: codes.map((code) => ({ Message: 'm', Detail: 'd', code })), type: 'ValidationFault' }, ...extra, time: TIME }) },
  });
  it.each<[string, Json]>([
    ['a 200 carrying Fault 610', fault(200, ['610'])],
    ['a 500 carrying Fault 610', fault(500, ['610'])],
    ['a 200 carrying Fault 610 beside the moved Purchase', fault(200, ['610'], { Purchase: afterBook().Purchase })],
    ['a 400 whose first code is 610, its second 6000', fault(400, ['610', '6000'])],
  ])('%s: settled unsettled, deleted; not-sent.json, nothing sent', async (_label, book) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = book;
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/not-sent.json`);
    expect(w.fake.requests()[1]).toMatchObject({ cmd: 'outcome', key: KEY, result: 'unsettled', note: 'deleted' });
    expect(rig.posts()).toEqual([]);
  });
  it.each<[string, Json]>([
    ['a 400 whose first code is 6000, its second 610', fault(400, ['6000', '610'])],
    ['a 200 whose first code is 6000, its second 610', fault(200, ['6000', '610'])],
  ])('%s: it stays unknown (unknown.json), no outcome asked', async (_label, book) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = book;
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
});

describe('task-8-1 TM5: the undo’s intent request is intent-undo.json’s as text, whatever order the lookup’s keys are in', () => {
  const reversed = (o: Json): Json => Object.fromEntries(Object.entries(o).reverse());
  it.each<[string, (line: Json) => Json]>([
    ['each side’s keys reversed', (line) => ({ line_id: line.line_id, before: reversed(line.before), after: reversed(line.after) })],
    ['each line’s keys reversed', (line) => reversed(line)],
    ['both', (line) => reversed({ line_id: line.line_id, before: reversed(line.before), after: reversed(line.after) })],
  ])('%s: sent.json, the request equal as text', async (_label, reorder) => {
    const w = undoWorld({ lookup: [lookup((a) => (a.intent.lines = a.intent.lines.map(reorder)))], intent: ['intent-undo.json'], outcome: [OK] });
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify(vector('intent-undo.json').request));
  });
});

describe('task-8-1 TM6: undo on its server’s mono and switch (spec §3 T1, T2)', () => {
  it('an injected mono far from performance.now: the undo registers on it and sends (sent.json)', async () => {
    const w = undoWorld();
    const { client, mode } = await w.start({ mono: () => 5_000_000_000 });
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect([rig.posts().length, mode.registry.size]).toEqual([1, 0]);
  });
  it('the injected mono 60000 ms on between the undo’s check and its registration: fork-error, no POST', async () => {
    const w = undoWorld();
    // The check reads it first (0), the registration next (60000).
    let n = 0;
    const { client, mode } = await w.start({ mono: () => (n++ === 0 ? 0 : 60_000) });
    expect(await client.callTool(undo())).toEqual(forkReason({ reason: 'fork-error' }));
    expect([rig.posts(), mode.registry.size, cmds(w)]).toEqual([[], 0, ['lookup', 'intent']]);
  });

  /** The kit's fs with an unlink that fails EACCES: the switch can't be deleted, so the server's latch is set. */
  const stuck = () => {
    const real = createKit().fs;
    const unlink = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    return { stat: real.stat, unlink: unlink as unknown as typeof real.unlink };
  };
  const categorize = () => ({ name: 'qbo_categorize_purchase', arguments: JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8')) });
  const own = { lookup: [lookup()], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] };
  it.each<[string, Json, (w: World) => void, RegExp]>([
    [
      'a settled sent-diff in the undo’s step 4',
      { lookup: [lookup(unknownAt(DUE))], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK, OK] },
      (w) => (w.books['purchase/1001'] = afterBook((txn) => (txn.TotalAmt = 121))),
      /^\{"result":"sent",/,
    ],
    [
      'the undo’s own send stored with a difference (sent-diff)',
      own,
      (w) => {
        const echo = storeEcho(w);
        w.post = (c) => {
          const body = JSON.parse(echo(c).body as string);
          body.Purchase.TotalAmt = 121;
          return { status: 200, body: JSON.stringify(body) };
        };
      },
      /^\{"result":"sent-diff",.*"writes_off":false,/,
    ],
    [
      'the undo’s own send answered with another transaction’s id (id-mismatch)',
      own,
      (w) => (w.post = () => ({ status: 200, body: JSON.stringify({ Purchase: { ...afterBook().Purchase, Id: '1009', SyncToken: '5' }, time: TIME }) })),
      /^reason: write:unknown\nreceipt: [^\n]*\nnote: id-mismatch\n/,
    ],
  ])('%s, the switch file undeletable: the latch is the server’s one, so categorize is then refused (disabled.json)', async (_label, script, setup, first) => {
    const w = undoWorld(script);
    setup(w);
    const { client } = await w.start({ fs: stuck() });
    const r: any = await client.callTool(undo());
    expect(r.content[0].text).toMatch(first);
    expect(existsSync(w.switchPath)).toBe(true);
    expectFile(await client.callTool(categorize()), 'qbo_categorize_purchase/disabled.json');
    expect(rig.posts()).toHaveLength(1);
  });
});

/** A GET answered `status` with `top`'s keys (a Fault, an entity, both) and the time. */
const answered = (status: number, top: Json): Json => ({ answer: { status, body: JSON.stringify({ ...top, time: TIME }) } });
/** A Fault whose `Error` is `errors` as given. */
const faultWith = (errors: unknown): Json => ({ Fault: { Error: errors, type: 'ValidationFault' } });
/** A Fault whose one Error item has `code` as given (a string, a number, null). */
const faultCoded = (code: unknown): Json => faultWith([{ Message: 'm', Detail: 'd', code }]);
/** Bodies that hold no Fault (§17: a non-empty `Fault.Error` array whose first item has a string `code`). */
const NOT_FAULTS: Array<[string, Json]> = [
  ['a first code that is the number 610', faultCoded(610)],
  ['a first code that is the number 6000', faultCoded(6000)],
  ['a first code that is null', faultCoded(null)],
  ['an empty Error array', faultWith([])],
  ['an Error that isn’t an array (an object with code 610)', faultWith({ Message: 'm', code: '610' })],
  // T9 TP1: only the first item's code counts; a string code on a later item makes no Fault.
  ['a first item whose code is the number 610, then one whose code is the string 6000', faultWith([{ Message: 'm', code: 610 }, { Message: 'm', code: '6000' }])],
];

describe('task-8-2 TN1: the settle’s refetch reads any Fault before the entity, in any status (§17 Send answers; Settling rows 5-6)', () => {
  const unmoved = () => fixture('fetched/purchase-1001.json').Purchase;
  it.each<[string, Json]>([
    ['a 200 holding Fault 6000 beside the moved Purchase', answered(200, { ...faultCoded('6000'), Purchase: afterBook().Purchase })],
    ['a 200 holding Fault 6000 beside the unmoved Purchase', answered(200, { ...faultCoded('6000'), Purchase: unmoved() })],
    ['a 500 holding Fault 6000 beside the moved Purchase', answered(500, { ...faultCoded('6000'), Purchase: afterBook().Purchase })],
    ['a 404 holding Fault 6000 beside the moved Purchase', answered(404, { ...faultCoded('6000'), Purchase: afterBook().Purchase })],
    ['a 200 whose first code is off §17’s pattern ("610 ") beside the moved Purchase', answered(200, { ...faultCoded('610 '), Purchase: afterBook().Purchase })],
    ['a 200 whose first code is off §17’s pattern ("") beside the unmoved Purchase', answered(200, { ...faultCoded(''), Purchase: unmoved() })],
  ])('%s: it stays unknown (unknown.json), only the lookup run, nothing sent', async (_label, book) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: ['intent-undo.json'], outcome: [OK, OK] });
    w.books['purchase/1001'] = book;
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
});

describe('task-8-2 TN3: no Fault is read where §17 sees none (a string first code), on the settle’s refetch', () => {
  it.each(NOT_FAULTS)('%s, with no entity: it stays unknown (unknown.json), only the lookup run', async (_label, top) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [OK] });
    w.books['purchase/1001'] = answered(400, top);
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
  it.each(NOT_FAULTS)('%s, beside the moved Purchase in a 200: the Purchase is read, settled sent, then the undo sends', async (_label, top) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: ['intent-undo.json'], outcome: [OK, OK] });
    w.books['purchase/1001'] = answered(200, { ...top, Purchase: afterBook().Purchase });
    // The settle's refetch reads the body above; step 6's fetch (the second GET) reads the plain book.
    let gets = 0;
    w.onGet = (path) => {
      if (path === 'purchase/1001' && ++gets === 2) w.books['purchase/1001'] = afterBook();
    };
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(w.fake.requests()[1]).toMatchObject({ cmd: 'outcome', key: KEY, result: 'sent', sync_token_after: '4' });
  });
});

describe('task-8-2 TN1-TN3: step 6’s refetch after the undo’s own unanswered send reads any Fault before the entity (§17 step 6)', () => {
  const own = () => ({ lookup: [lookup()], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] });
  /** Purchase 1001 as the undo leaves it: SyncToken 5, line 1 back on 77 with no class. */
  const putBack = (): Json => afterBook((t) => ((t.SyncToken = '5'), (t.Line[0].AccountBasedExpenseLineDetail = { AccountRef: { value: '77' } }))).Purchase;
  const unanswered = (w: World, refetched: Json) => (w.post = () => ((w.books['purchase/1001'] = refetched), { status: 500, body: '{}' }));
  it.each<[string, Json]>([
    ['a 200 holding Fault 6000 beside the put-back Purchase', answered(200, { ...faultCoded('6000'), Purchase: putBack() })],
    ['a 200 holding Fault 6000 beside the unmoved Purchase', answered(200, { ...faultCoded('6000'), Purchase: afterBook().Purchase })],
    ['a 500 holding Fault 6000 beside the put-back Purchase', answered(500, { ...faultCoded('6000'), Purchase: putBack() })],
    ['a 404 holding Fault 6000 beside the put-back Purchase', answered(404, { ...faultCoded('6000'), Purchase: putBack() })],
    ['a 200 holding Fault 610 beside the put-back Purchase', answered(200, { ...faultCoded('610'), Purchase: putBack() })],
    ['a 200 whose first code is off §17’s pattern ("610 ") beside the put-back Purchase', answered(200, { ...faultCoded('610 '), Purchase: putBack() })],
    ['a 200 holding the put-back copy under Bill (task-8-2 TN2’s twin)', answered(200, { Bill: putBack() })],
  ])('%s: write:unknown with its own receipt, the unknown outcome asked, never sent again', async (_label, refetched) => {
    const w = undoWorld(own());
    unanswered(w, refetched);
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: NEW, result: 'unknown' });
    expect(rig.posts()).toHaveLength(1);
  });
  it.each<[string, Json]>([['no Fault at all', {}], ...NOT_FAULTS])('%s beside the put-back Purchase in a 200: stored (sent.json), one POST', async (_label, top) => {
    const w = undoWorld(own());
    unanswered(w, answered(200, { ...top, Purchase: putBack() }));
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/sent.json`);
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: NEW, result: 'sent', sync_token_after: '5' });
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('T9 TP2: the shared reader reads the entity only in a 2xx and only with the asked Id as a string (§17 steps 4 and 6)', () => {
  /** The moved copy with its Id the number 1001. */
  const numberId = (txn: Json): Json => ({ ...txn, Id: 1001 });
  it.each<[string, Json]>([
    ['a 302 holding the moved Purchase', answered(302, { Purchase: afterBook().Purchase })],
    ['a 200 holding the moved Purchase with its Id the number 1001', answered(200, { Purchase: numberId(afterBook().Purchase) })],
  ])('the settle’s refetch: %s is no transaction, so it stays unknown (unknown.json), only the lookup run', async (_label, book) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], intent: ['intent-undo.json'], outcome: [OK, OK] });
    w.books['purchase/1001'] = book;
    const { client } = await w.start();
    expectFile(await client.callTool(undo()), `${UNDO}/unknown.json`);
    expect([cmds(w), rig.posts()]).toEqual([['lookup'], []]);
  });
  const putBack = (): Json => afterBook((t) => ((t.SyncToken = '5'), (t.Line[0].AccountBasedExpenseLineDetail = { AccountRef: { value: '77' } }))).Purchase;
  it.each<[string, Json]>([
    ['a 302 holding the put-back Purchase', answered(302, { Purchase: putBack() })],
    ['a 200 holding the put-back Purchase with its Id the number 1001', answered(200, { Purchase: numberId(putBack()) })],
  ])('step 6’s refetch after the undo’s own unanswered send: %s is no transaction, so write:unknown, never sent again', async (_label, refetched) => {
    const w = undoWorld({ lookup: [lookup()], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK] });
    w.post = () => ((w.books['purchase/1001'] = refetched), { status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks didn't answer; the change will be settled by a later check.`));
    expect(w.fake.requests()[2]).toMatchObject({ cmd: 'outcome', key: NEW, result: 'unknown' });
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('T9 TQ1 (task-9-1 TR1, TR3-TR5, TR8): once step 4’s settle found a sent-diff, every result of the call says what it did to the switch file', () => {
  const SWITCHED = ' Writes are switched off.';
  const STUCK = " The switch file couldn't be deleted; delete it by hand.";
  const due = (outcome: Json[] = [OK, OK], intent: unknown = { answer: { ok: true, key: NEW, n: 1 } }) => ({ lookup: [lookup(unknownAt(DUE))], intent: [intent], outcome });
  /** The settle's refetch: moved by one with the after values and TotalAmt 121, so it settles sent-diff. */
  const diffBook = () => afterBook((txn) => (txn.TotalAmt = 121));
  /** The kit's fs with an unlink that fails EACCES (the latch). */
  const stuckFs = () => {
    const real = createKit().fs;
    const unlink = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    return { stat: real.stat, unlink: unlink as unknown as typeof real.unlink };
  };
  /** How the settle's deletion went: deleted; the latch (EACCES); the file already gone (ENOENT). */
  const SETTLES: Record<'deleted' | 'stuck' | 'gone', { tail: string; start: (w: World) => Json; file: boolean }> = {
    deleted: { tail: SWITCHED, start: () => ({}), file: false },
    stuck: { tail: STUCK, start: () => ({ fs: stuckFs() }), file: true },
    gone: { tail: '', start: (w) => (rmSync(w.switchPath, { force: true }), {}), file: false },
  };
  const unknownText = (free: string) => `reason: write:unknown\nreceipt: ${NEW}\n\n${free}`;
  const stale = () => ({ status: 400, body: JSON.stringify({ Fault: { Error: [{ Message: 'm', code: '5010' }], type: 'ValidationFault' }, time: TIME }) });
  /** A 400 Fault whose Message QuickBooks wrote as `message`: the 1.0 http-400 carries it as its free text. */
  const said400 = (message: string) => ({ answer: { status: 400, body: JSON.stringify({ Fault: { Error: [{ Message: message, code: '9999' }], type: 'ValidationFault' }, time: TIME }) } });
  const ID_MISMATCH = "QuickBooks answered with another transaction's id; writes are switched off.";
  /** Each error after the settle: its setup (the script's intent answer, and the world), the result's text before any sentence. */
  const ERRORS: Array<[string, { intent?: unknown; setup?: (w: World) => Json | void }, string]> = [
    [
      'step 9: the lines changed since (the second GET has line 1 on 91)',
      {
        setup: (w) => {
          let gets = 0;
          w.onGet = (path) => {
            if (path === 'purchase/1001' && ++gets === 2) w.books['purchase/1001'] = afterBook((txn) => ((txn.TotalAmt = 121), (txn.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '91')));
          };
        },
      },
      'reason: write:changed-since\n\nSomeone changed these lines since; nothing was sent.',
    ],
    ['step 6: a 1.0 reason (preferences answered 500)', { setup: (w) => void (w.books.preferences = { answer: { status: 500, body: '{}' } }) }, (forkReason({ reason: 'http-500' }).content[0] as { text: string }).text],
    // TR8: QuickBooks' own words are never the fork's sentence, wherever they hold it.
    [
      'step 6: a 1.0 http-400 whose Fault message is "Writes are switched off."',
      { setup: (w) => void (w.books.preferences = said400('Writes are switched off.')) },
      'reason: http-400\n\nQuickBooks answered 400. QuickBooks said: Writes are switched off.',
    ],
    [
      'step 6: a 1.0 http-400 whose Fault message holds "writes are switched off." inside',
      { setup: (w) => void (w.books.preferences = said400('Note: writes are switched off. Try later')) },
      'reason: http-400\n\nQuickBooks answered 400. QuickBooks said: Note: writes are switched off. Try later',
    ],
    // TR3: the change flow refusing before the send.
    ['the undo’s intent answered not ok with no key', { intent: { answer: { ok: false, reason: 'write:receipt-failed', cause: 'lock' } } }, INTENT_NO_KEY],
    ['the undo’s intent answered not ok with this call’s key', { intent: { answer: { ...vector('intent-receipt-failed.json').answer, key: NEW } } }, intentKeyText(NEW)],
    [
      'a refused registration (the mono 60000 ms on between the check and the registration)',
      {
        setup: () => {
          let n = 0;
          return { mono: () => (n++ === 0 ? 0 : 60_000) };
        },
      },
      (forkReason({ reason: 'fork-error' }).content[0] as { text: string }).text,
    ],
    ['the undo’s own send answered Fault 5010 (stale)', { setup: (w) => void (w.post = stale) }, `reason: write:stale\nreceipt: ${NEW}\n\nSomeone edited the transaction meanwhile; nothing was overwritten.`],
    ['the undo’s own send unanswered, the refetch unmoved', { setup: (w) => void (w.post = () => ({ status: 500, body: '{}' })) }, unknownText("QuickBooks didn't answer; the change will be settled by a later check.")],
  ];
  it.each(ERRORS.flatMap(([label, how, text]) => (['deleted', 'stuck', 'gone'] as const).map((kind) => [label, kind, how, text] as const)))(
    'a settled sent-diff, then %s, the settle’s deletion %s: the result ends once with what it did',
    async (_label, kind, how, text) => {
      const w = undoWorld(due([OK, OK], how.intent));
      w.books['purchase/1001'] = diffBook();
      const settled = SETTLES[kind];
      const opts = { ...settled.start(w), ...(how.setup?.(w) ?? {}) };
      const { client } = await w.start(opts);
      expect(await client.callTool(undo())).toEqual(errorText(`${text}${settled.tail}`));
      expect(existsSync(w.switchPath)).toBe(settled.file);
    },
  );
  /** The undo's own send answered another id (Purchase 1009); its refetch, as `book` leaves it. */
  const idMismatch = (w: World, book: (c: StubCall) => void) => (c: StubCall) => {
    book(c);
    return { status: 200, body: JSON.stringify({ Purchase: { ...diffBook().Purchase, Id: '1009', SyncToken: '5' }, time: TIME }) };
  };
  it.each<['deleted' | 'stuck' | 'gone', string]>([
    // The id-mismatch text says it already: not twice.
    ['deleted', ''],
    ['stuck', STUCK],
    ['gone', ''],
  ])('a settled sent-diff (%s), then the undo’s own send answered another id, the refetch unmoved: the id-mismatch unknown, its sentence once', async (kind, tail) => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    w.post = idMismatch(w, () => undefined);
    const { client } = await w.start(SETTLES[kind].start(w));
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\nnote: id-mismatch\n\n${ID_MISMATCH}${tail}`));
  });

  /** contract §14's writes_off as the home grammar test reads it (quickbooks-write-contract.test.js, rule `change-writes-off`). */
  const writesOffHolds = (c: Json): boolean => c.writes_off === (c.result === 'sent-diff' || c.note === 'id-mismatch');
  const warned = (r: Json, tail: string): Json => (tail === '' ? r : { content: [...r.content, { type: 'text', text: `WARNING:${tail}` }] });
  /** The undo's own send stored with TotalAmt 122: a sent-diff naming TotalAmt. */
  const storedDiff = (w: World) => {
    const echo = storeEcho(w);
    w.post = (c) => {
      const body = JSON.parse(echo(c).body as string);
      body.Purchase.TotalAmt = 122;
      return { status: 200, body: JSON.stringify(body) };
    };
  };
  /** Every undo success after a settled sent-diff: how the settle's deletion went, the undo's own answer, the change item's keys, the tail. */
  const SUCCESSES: Array<[string, 'deleted' | 'stuck' | 'gone', (w: World) => void, Json, string, boolean]> = [
    ['its own send stored as sent', 'deleted', () => undefined, {}, SWITCHED, true],
    ['its own send stored as sent', 'stuck', () => undefined, {}, STUCK, true],
    ['its own send stored as sent', 'gone', () => undefined, {}, '', true],
    // This call's settle deleted the file, so the attempt's own sent-diff finds it gone: the server deleted it, writes_off true (§14).
    ['its own send stored with a difference too', 'deleted', storedDiff, { result: 'sent-diff', diff: ['TotalAmt'], writes_off: true }, SWITCHED, true],
    // Spec §3 T2's decided exception (nothing deleted: writes_off false), which the home rule refuses as it did before T9.
    ['its own send stored with a difference too', 'stuck', storedDiff, { result: 'sent-diff', diff: ['TotalAmt'], writes_off: false }, STUCK, false],
    ['its own send stored with a difference too', 'gone', storedDiff, { result: 'sent-diff', diff: ['TotalAmt'], writes_off: false }, '', false],
    // TR4: another id answered, the refetch stored: note id-mismatch with writes_off true, the settle's deletion being this call's.
    ['its own send answered another id, the refetch stored', 'deleted', (w) => (w.post = idMismatch(w, storeEcho(w))), { note: 'id-mismatch', writes_off: true }, SWITCHED, true],
    ['its own send answered another id, the refetch stored', 'stuck', (w) => (w.post = idMismatch(w, storeEcho(w))), { note: 'id-mismatch', writes_off: false }, STUCK, false],
  ];
  it.each(SUCCESSES)('a settled sent-diff, then %s, the settle’s deletion %s: the whole result, and §14’s writes_off rule', async (_label, kind, setup, over, tail, holds) => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    setup(w);
    const { client } = await w.start(SETTLES[kind].start(w));
    const r: any = await client.callTool(undo());
    expect(r).toEqual(warned(sentWith(over), tail));
    expect(writesOffHolds(JSON.parse(r.content[0].text))).toBe(holds);
  });
  it('a settled sent ("sent", no difference): the switch file stays, sent.json whole, no sentence', async () => {
    const w = undoWorld(due());
    const { client } = await w.start();
    const r: any = await client.callTool(undo());
    expectFile(r, `${UNDO}/sent.json`);
    expect(writesOffHolds(JSON.parse(r.content[0].text))).toBe(true);
    expect(existsSync(w.switchPath)).toBe(true);
  });
  it.each<['deleted' | 'stuck' | 'gone', string]>([
    ['deleted', SWITCHED],
    ['stuck', STUCK],
    ['gone', ''],
  ])('a settled sent-diff (%s), its outcome not recorded: the settle’s receipt-failed, then what the settle did', async (kind, tail) => {
    const w = undoWorld({ lookup: [lookup(unknownAt(DUE))], outcome: [NOT_OK] });
    w.books['purchase/1001'] = diffBook();
    const { client } = await w.start(SETTLES[kind].start(w));
    expect(await client.callTool(undo())).toEqual(errorText(`${SETTLE_FAILED}${tail}`));
  });
  it('the switch file a directory at the settle (its unlink fails, the latch): the stuck sentence', async () => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    rmSync(w.switchPath, { force: true });
    mkdirSync(w.switchPath);
    const { client } = await w.start();
    expect(await client.callTool(undo())).toEqual(warned(sentWith({}), STUCK));
    rmSync(w.switchPath, { recursive: true, force: true });
  });
  it('the unlink failing and the stat after it failing too (not ENOENT): the stuck sentence (fail closed)', async () => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    const stat = async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    const { client } = await w.start({ fs: { stat: stat as unknown as ReturnType<typeof stuckFs>['stat'], unlink: stuckFs().unlink } });
    expect(await client.callTool(undo())).toEqual(warned(sentWith({}), STUCK));
  });

  // task-9-1 follow-up N02: what the switch file shows last decides the sentence: the undo's own turnOff when it ran, else the settle's.
  /** The kit's fs whose unlinks go as `plan` says, in order (`fail`: EACCES, the latch; `real`: the real one); after the plan, real. */
  const plannedFs = (...plan: Array<'real' | 'fail'>) => {
    const real = createKit().fs;
    let n = 0;
    const unlink = async (p: string) => {
      if (plan[n++] === 'fail') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real.unlink(p);
    };
    return { stat: real.stat, unlink: unlink as unknown as typeof real.unlink };
  };
  /** The undo's own send, after `act` did something to the switch file. */
  const first = (w: World, act: () => void) => {
    const send = w.post;
    w.post = (c, n) => (act(), send(c, n));
  };
  const OWN: Array<[string, Array<'real' | 'fail'>, (w: World) => void, Json, string, boolean]> = [
    // The settle stuck, then the undo's own answer deleted the file: writes are off, said once, and no by-hand sentence.
    ['the settle stuck, then its own sent-diff deleted the file', ['fail'], storedDiff, { result: 'sent-diff', diff: ['TotalAmt'], writes_off: true }, SWITCHED, false],
    ['the settle stuck, then its own id-mismatch deleted the file (the refetch stored)', ['fail'], (w) => (w.post = idMismatch(w, storeEcho(w))), { note: 'id-mismatch', writes_off: true }, SWITCHED, false],
    // The settle stuck, then the file went (not this server): nothing to delete by hand, and nothing this attempt deleted.
    ['the settle stuck, the file gone before its own sent-diff', ['fail'], (w) => (storedDiff(w), first(w, () => rmSync(w.switchPath, { force: true }))), { result: 'sent-diff', diff: ['TotalAmt'], writes_off: false }, '', false],
    // The settle deleted it, then the file came back and its own unlink failed: the file is there, so writes aren't off.
    ['the settle deleted the file, it came back, its own sent-diff could not delete it', ['real', 'fail'], (w) => (storedDiff(w), first(w, () => writeFileSync(w.switchPath, ''))), { result: 'sent-diff', diff: ['TotalAmt'], writes_off: false }, STUCK, true],
  ];
  it.each(OWN)('N02: %s: the whole result, its sentence once, and where the file is', async (_label, plan, setup, over, tail, file) => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    setup(w);
    const { client } = await w.start({ fs: plannedFs(...plan) });
    expect(await client.callTool(undo())).toEqual(warned(sentWith(over), tail));
    expect(existsSync(w.switchPath)).toBe(file);
  });
  it.each<[string, Array<'real' | 'fail'>, (w: World) => void, string, boolean]>([
    // The id-mismatch sentence says it: not twice, and no by-hand sentence.
    ['the settle stuck, then its own id-mismatch deleted the file (the refetch unmoved)', ['fail'], () => undefined, '', false],
    ['the settle deleted the file, it came back, its own id-mismatch could not delete it (the refetch unmoved)', ['real', 'fail'], (w) => first(w, () => writeFileSync(w.switchPath, '')), STUCK, true],
  ])('N02: %s: the id-mismatch unknown, then what the file shows', async (_label, plan, setup, tail, file) => {
    const w = undoWorld(due());
    w.books['purchase/1001'] = diffBook();
    w.post = idMismatch(w, () => undefined);
    setup(w);
    const { client } = await w.start({ fs: plannedFs(...plan) });
    expect(await client.callTool(undo())).toEqual(errorText(`reason: write:unknown\nreceipt: ${NEW}\nnote: id-mismatch\n\n${ID_MISMATCH}${tail}`));
    expect(existsSync(w.switchPath)).toBe(file);
  });
});

afterAll(() => {
  if (nameFiltered()) return;
  const files = readdirSync(fakePath(`tool-results/${UNDO}`)).map((f) => `${UNDO}/${f}`);
  expect(files.filter((f) => !produced.has(f))).toEqual([]);
});
