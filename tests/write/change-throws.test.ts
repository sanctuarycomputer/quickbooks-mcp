// Sanctuary Computer (quickbooks-mcp-294): A1.16's throws that need a module mocked before the flow is imported: the answer reader
// (src/write/answer.js) and the renderer (src/write/results.js). Each mock's default is the built module's own function (dist/, which
// entry.test.ts holds fresh), so only the case that asks for a throw gets one. After the send, a throw answers write:unknown with the
// receipt; the outcome is asked once per attempt, never again after it was answered; and when the unknown can't be rendered either, the
// last answer still carries the receipt.
import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';

/** A module of dist/write, by name (a template, so its type is the source's, given here). */
const built = (name: string): Promise<unknown> => import(`../../dist/write/${name}.js`);
const builtAnswer = (await built('answer')) as typeof import('../../src/write/answer.js');
const builtResults = (await built('results')) as typeof import('../../src/write/results.js');
const readAnswer = jest.fn(builtAnswer.readAnswer);
const writeSuccess = jest.fn(builtResults.writeSuccess);
const writeError = jest.fn(builtResults.writeError);
jest.unstable_mockModule('../../src/write/answer', () => ({ ...builtAnswer, readAnswer }));
jest.unstable_mockModule('../../src/write/results', () => ({ ...builtResults, writeSuccess, writeError }));

const { fakePath } = await import('../helpers/server.js');
const { fixture } = await import('./derive.js');
const { stubOf, world, writeRig } = await import('./write-rig.js');

jest.setTimeout(30000);
const rig = writeRig();
const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const call = () => ({ name: 'qbo_categorize_purchase', arguments: JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8')) });
const expected = (rel: string) => JSON.parse(readFileSync(fakePath(`tool-results/qbo_categorize_purchase/${rel}`), 'utf8'));
const boom = () => {
  throw new Error('boom');
};

describe('A1.16, with a module mocked', () => {
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

  it('a throw after the outcome was answered (rendering the success): no second outcome; unknown with the receipt, from the outcome recorded', async () => {
    writeSuccess.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual({
      content: [{ type: 'text', text: `reason: write:unknown\nreceipt: ${KEY}\nrecorded: ledger\n\nQuickBooks didn't answer; the change will be settled by a later check.` }],
      isError: true,
    });
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
    expect((w.fake.requests()[1] as any).result).toBe('sent');
  });

  it('the unknown itself can’t be rendered: the last answer, the receipt and recorded: none', async () => {
    writeSuccess.mockImplementationOnce(boom);
    writeError.mockImplementationOnce(boom);
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stubOf(fixture('answers/update-sent.json'));
    const { client } = await w.start();
    expect(await client.callTool(call())).toEqual(expected('unknown-recorded-none.json'));
    expect(w.fake.requests().map((r: any) => r.cmd)).toEqual(['intent', 'outcome']);
  });
});
