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
});
