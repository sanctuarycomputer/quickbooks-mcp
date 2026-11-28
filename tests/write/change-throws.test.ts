// Sanctuary Computer (quickbooks-mcp-294): A1.16's throws that need a module mocked before the flow is imported: the answer reader
// (src/write/answer.js), the renderer (src/write/results.js) and the compare (src/write/compare.js). Each mock's default is the built module's own function (dist/, which
// entry.test.ts holds fresh), so only the case that asks for a throw gets one. After the send, a throw answers write:unknown with the
// receipt; the outcome is asked once per attempt, never again after it was answered, and keeps its note; a throw after a sent, sent-diff,
// stale or failed outcome was asked says what was decided and never that a later check will settle it (TK7); and when that can't be
// rendered either, the last answer still carries the receipt.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';

/** A module of dist/write, by name (a template, so its type is the source's, given here). */
const built = (name: string): Promise<unknown> => import(`../../dist/write/${name}.js`);
const builtAnswer = (await built('answer')) as typeof import('../../src/write/answer.js');
const builtResults = (await built('results')) as typeof import('../../src/write/results.js');
const builtCompare = (await built('compare')) as typeof import('../../src/write/compare.js');
const readAnswer = jest.fn(builtAnswer.readAnswer);
const writeSuccess = jest.fn(builtResults.writeSuccess);
const writeError = jest.fn(builtResults.writeError);
jest.unstable_mockModule('../../src/write/answer', () => ({ ...builtAnswer, readAnswer }));
const compare = jest.fn(builtCompare.compare);
jest.unstable_mockModule('../../src/write/results', () => ({ ...builtResults, writeSuccess, writeError }));
jest.unstable_mockModule('../../src/write/compare', () => ({ ...builtCompare, compare }));

const { fakePath } = await import('../helpers/server.js');
const { fixture } = await import('./derive.js');
const { stubOf, world, writeRig } = await import('./write-rig.js');
const { existsSync } = await import('fs');

jest.setTimeout(30000);
const rig = writeRig();
const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const call = () => ({ name: 'qbo_categorize_purchase', arguments: JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8')) });
const expected = (rel: string) => JSON.parse(readFileSync(fakePath(`tool-results/qbo_categorize_purchase/${rel}`), 'utf8'));
const boom = () => {
  throw new Error('boom');
};

describe('A1.16, with a module mocked', () => {
  // A mockImplementation (not Once) outlives its test under clearMocks: each mock is put back to the built function after every test.
  afterEach(() => {
    readAnswer.mockImplementation(builtAnswer.readAnswer);
    writeSuccess.mockImplementation(builtResults.writeSuccess);
    writeError.mockImplementation(builtResults.writeError);
    compare.mockImplementation(builtCompare.compare);
  });
  it('a throw in the answer reader: unknown.json, the unknown outcome asked once', async () => {
    readAnswer.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(expected('unknown.json'));
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
    expect(JSON.stringify(w.fake.requests()[1])).toBe(JSON.stringify((await import('./receipt-fake.js')).vector('outcome-unknown.json').request));
    expect(rig.posts()).toHaveLength(1);
  });

  /** A write:unknown with the receipt, the header lines given, and `free`. */
  const unknownWith = (head: string, free: string) => ({ content: [{ type: 'text', text: `reason: write:unknown\nreceipt: ${KEY}${head}\n\n${free}` }], isError: true });
  it('TK7: a throw after a sent outcome was recorded (rendering the success): no second outcome; the receipt and what was decided, no later check', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(unknownWith('\nrecorded: ledger', "QuickBooks stored the change. Its outcome, sent, was recorded; this result couldn't be written."));
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
    expect((w.fake.requests()[1] as any).result).toBe('sent');
  });

  it('TK7: a throw after a sent-diff outcome was recorded: the change stored with differences, and writes switched off', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stubOf(fixture('answers/stored-amount.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(
      unknownWith('', "QuickBooks stored the change, with differences from what was asked. Its outcome, sent-diff, was recorded; this result couldn't be written. Writes are switched off."),
    );
    expect(w.fake.requests().map((r: any) => [r.cmd, r.result])).toEqual([['intent', undefined], ['outcome', 'sent-diff']]);
    expect(existsSync(w.switchPath)).toBe(false);
  });

  it('TK7: a throw rendering a stale result, its outcome not confirmed recorded: refused, stale, not confirmed recorded', async () => {
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false, reason: 'failed', cause: 'lock' } }] });
    w.post = () => stubOf(fixture('answers/stale.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(
      unknownWith('\nrecorded: none', "QuickBooks refused the change: the transaction had changed since it was read. Its outcome, stale, wasn't confirmed recorded; this result couldn't be written."),
    );
    expect(w.fake.requests().map((r: any) => [r.cmd, r.result])).toEqual([['intent', undefined], ['outcome', 'stale']]);
  });

  it('TK7: a throw rendering a failed result (Fault 6000): refused, failed, recorded', async () => {
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => ({ status: 400, body: JSON.stringify({ Fault: { Error: [{ Message: 'm', Detail: 'd', code: '6000' }], type: 'ValidationFault' }, time: '2026-11-18T09:00:00.000-08:00' }) });
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(unknownWith('', "QuickBooks refused the change. Its outcome, failed, was recorded; this result couldn't be written."));
  });

  it('TK6: a throw after an id-mismatch was noted (in the compare of the refetch): the one unknown outcome keeps note id-mismatch', async () => {
    compare.mockImplementation(((stored: any, ...rest: any[]) => {
      if (stored?.SyncToken === '4' && stored?.Id === '1001') throw new Error('compare');
      return (builtCompare.compare as any)(stored, ...rest);
    }) as any);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => {
      w.books['purchase/1001'] = fixture('answers/update-sent.json').body;
      return stubOf(((f) => ((f.body.Purchase.Id = '1009'), f))(fixture('answers/update-sent.json')));
    };
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(expected('unknown-id-mismatch.json'));
    expect(w.fake.requests().slice(1).map((r: any) => [r.cmd, r.key, r.result, r.note])).toEqual([['outcome', KEY, 'unknown', 'id-mismatch']]);
    expect(existsSync(w.switchPath)).toBe(false);
  });

  it('the result can’t be rendered either (a sent outcome recorded in Notion): the last answer, the receipt and what was decided', async () => {
    writeSuccess.mockImplementationOnce(boom);
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(unknownWith('', "QuickBooks stored the change. Its outcome, sent, was recorded; this result couldn't be written."));
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
  });

  it('the last answer after an id-mismatch then a sent recorded in the ledger: its note and recorded lines, and writes switched off', async () => {
    writeSuccess.mockImplementationOnce(boom);
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => {
      w.books['purchase/1001'] = fixture('answers/update-sent.json').body;
      return stubOf(((f) => ((f.body.Purchase.Id = '1009'), f))(fixture('answers/update-sent.json')));
    };
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(
      unknownWith('\nnote: id-mismatch\nrecorded: ledger', "QuickBooks stored the change. Its outcome, sent, was recorded; this result couldn't be written. Writes are switched off."),
    );
    expect(w.fake.requests().map((r: any) => [r.cmd, r.result, r.note])).toEqual([['intent', undefined, undefined], ['outcome', 'sent', 'id-mismatch']]);
  });

  it('no answer, and the unknown can’t be rendered: the last answer is unknown-recorded-none.json', async () => {
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false, reason: 'failed', cause: 'lock' } }] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(expected('unknown-recorded-none.json'));
  });

  /** An update answered with another Id (1009), the books then holding `stored`. */
  const mismatch = (w: any, stored: unknown) => () => {
    w.books['purchase/1001'] = stored;
    return stubOf(((f) => ((f.body.Purchase.Id = '1009'), f))(fixture('answers/update-sent.json')));
  };
  it.each<[string, unknown, string, string]>([
    ['recorded in the ledger', { ok: true, notion: false }, '\nrecorded: ledger', "QuickBooks didn't answer; the change will be settled by a later check."],
    ['recorded in Notion (no recorded line: unknown.json)', { ok: true, notion: true }, '', "QuickBooks didn't answer; the change will be settled by a later check."],
  ])('TL2: no answer, the unknown outcome %s, and it can’t be rendered: the last answer states recorded from the outcome’s answer', async (_label, answer, head, free) => {
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer }] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(unknownWith(head, free));
  });
  it.each<[string, unknown, string]>([
    ['recorded in Notion (unknown-id-mismatch.json)', { ok: true, notion: true }, '\nnote: id-mismatch'],
    ['not confirmed recorded', { ok: false, reason: 'failed', cause: 'lock' }, '\nnote: id-mismatch\nrecorded: none'],
  ])('TL2: an id-mismatch, the refetch unmoved, the unknown outcome %s, and it can’t be rendered: the last answer keeps note id-mismatch', async (_label, answer, head) => {
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer }] });
    w.post = mismatch(w, fixture('fetched/purchase-1001.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(unknownWith(head, "QuickBooks answered with another transaction's id; writes are switched off."));
    expect(w.fake.requests().map((r: any) => [r.cmd, r.result, r.note])).toEqual([['intent', undefined, undefined], ['outcome', 'unknown', 'id-mismatch']]);
  });

  it('TL1 (N23): an id-mismatch, the refetch moved and stored, and the success can’t be rendered: the decided answer keeps its note line', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = mismatch(w, fixture('answers/update-sent.json').body);
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(
      unknownWith('\nnote: id-mismatch', "QuickBooks stored the change. Its outcome, sent, was recorded; this result couldn't be written. Writes are switched off."),
    );
    expect(writeError).toHaveBeenCalledTimes(1);
  });

  it('TL1 (N18): the outcome’s run fails (its child throws as it is written), then the stale result can’t be rendered: the decided stale answer, recorded none', async () => {
    writeError.mockImplementationOnce(boom);
    const { createKit } = await import('../../src/write/kit.js');
    const real = createKit().spawn;
    let runs = 0;
    const throwing = () => {
      throw new Error('stdin');
    };
    const broken = () => ({ stdin: { on: () => undefined, end: throwing }, stdout: { on: () => undefined }, stderr: { on: () => undefined }, on: () => undefined, kill: () => undefined });
    const spawn = ((...a: Parameters<typeof real>) => (runs++ === 0 ? real(...a) : broken())) as typeof real;
    const w = world(rig, { intent: ['intent-ok.json'] });
    w.post = () => stubOf(fixture('answers/stale.json'));
    const { client } = await w.start({ spawn });
    expect(await client.callTool(call())).toEqual(
      unknownWith('\nrecorded: none', "QuickBooks refused the change: the transaction had changed since it was read. Its outcome, stale, wasn't confirmed recorded; this result couldn't be written."),
    );
    expect([runs, w.fake.requests().map((r: any) => r.cmd)]).toEqual([2, ['intent']]);
  });

  it('T9 TQ1: an undo whose step 4 settled a sent-diff (the switch file deleted), its own sent success unrenderable: the decided text says writes are off, once', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const { vector } = await import('./receipt-fake.js');
    const NEW = 'quickbooks-write:garden3d:purchase:1001:4:1';
    const TIME = '2026-11-18T09:00:00.000-08:00';
    const lookup = vector('lookup-ok.json').answer;
    lookup.outcome = { ...lookup.outcome, at: '2026-11-18T14:50:00.000Z', result: 'unknown', sync_token_after: null };
    const OK = { answer: { ok: true, notion: true } };
    const w = world(rig, { lookup: [{ answer: lookup }], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK, OK] });
    const book = fixture('fetched/purchase-1001-after.json');
    book.Purchase.TotalAmt = 121;
    w.books['purchase/1001'] = book;
    w.post = (c: { body: string }) => {
      const { sparse: _sparse, ...body } = JSON.parse(c.body);
      const txn = { ...body, SyncToken: String(Number(body.SyncToken) + 1), MetaData: { CreateTime: '2026-11-10T09:00:00-08:00' } };
      w.books['purchase/1001'] = { Purchase: txn, time: TIME };
      return { status: 200, body: JSON.stringify({ Purchase: txn, time: TIME }) };
    };
    const { client } = await w.start();
    const undo = JSON.parse(readFileSync(fakePath('tool-calls/qbo_undo_change.json'), 'utf8'));
    const r: any = await client.callTool({ name: 'qbo_undo_change', arguments: { ...undo, params: { receipt: KEY } } });
    expect(r).toEqual({ content: [{ type: 'text', text: `reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks stored the change. Its outcome, sent, was recorded; this result couldn't be written. Writes are switched off.` }], isError: true });
    expect([existsSync(w.switchPath), rig.posts().length]).toEqual([false, 1]);
  });
  it('task-9-1 follow-up N02: the settle’s deletion stuck, then the undo’s own sent-diff deleted the file, its success unrenderable: the decided text says writes are off, once, and no by-hand sentence', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const { vector } = await import('./receipt-fake.js');
    const { createKit } = await import('../../src/write/kit.js');
    const NEW = 'quickbooks-write:garden3d:purchase:1001:4:1';
    const TIME = '2026-11-18T09:00:00.000-08:00';
    const lookup = vector('lookup-ok.json').answer;
    lookup.outcome = { ...lookup.outcome, at: '2026-11-18T14:50:00.000Z', result: 'unknown', sync_token_after: null };
    const OK = { answer: { ok: true, notion: true } };
    const w = world(rig, { lookup: [{ answer: lookup }], intent: [{ answer: { ok: true, key: NEW, n: 1 } }], outcome: [OK, OK] });
    const book = fixture('fetched/purchase-1001-after.json');
    book.Purchase.TotalAmt = 121;
    w.books['purchase/1001'] = book;
    // Stored with TotalAmt 122: the undo's own answer is a sent-diff.
    w.post = (c: { body: string }) => {
      const { sparse: _sparse, ...body } = JSON.parse(c.body);
      const txn = { ...body, TotalAmt: 122, SyncToken: String(Number(body.SyncToken) + 1), MetaData: { CreateTime: '2026-11-10T09:00:00-08:00' } };
      w.books['purchase/1001'] = { Purchase: txn, time: TIME };
      return { status: 200, body: JSON.stringify({ Purchase: txn, time: TIME }) };
    };
    // The settle's unlink fails (the latch); the undo's own works.
    const real = createKit().fs;
    let n = 0;
    const unlink = async (p: string) => {
      if (n++ === 0) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      return real.unlink(p);
    };
    const { client } = await w.start({ fs: { stat: real.stat, unlink: unlink as unknown as typeof real.unlink } });
    const undo = JSON.parse(readFileSync(fakePath('tool-calls/qbo_undo_change.json'), 'utf8'));
    const r: any = await client.callTool({ name: 'qbo_undo_change', arguments: { ...undo, params: { receipt: KEY } } });
    expect(r).toEqual({ content: [{ type: 'text', text: `reason: write:unknown\nreceipt: ${NEW}\n\nQuickBooks stored the change, with differences from what was asked. Its outcome, sent-diff, was recorded; this result couldn't be written. Writes are switched off.` }], isError: true });
    expect([existsSync(w.switchPath), rig.posts().length, n]).toEqual([false, 1, 2]);
  });
});
