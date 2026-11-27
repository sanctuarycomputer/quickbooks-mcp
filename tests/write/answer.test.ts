// Sanctuary Computer (quickbooks-mcp-294): spec A1.7 at the reader, contract 1.2 §17 Send answers, steps 1-6 in order, the Fault's
// definition, the two 1.2 readings (an off-pattern Fault code and a stored answer whose SyncToken isn't digits are no answer), and the
// answer's intuit_tid kept only when it matches §5's pattern. The results these readings give are T7's (categorize.test.ts).
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { UpdateAnswer, UpdateEntity } from '../../src/write/client.js';
import { readAnswer } from '../../src/write/answer.js';

const TXNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes', 'transactions');
const file = (name: string): Record<string, any> => JSON.parse(readFileSync(join(TXNS, name), 'utf8'));

const PURCHASE = { entity: 'purchase' as UpdateEntity, id: '1001', syncToken: '3' };
const BILL = { entity: 'bill' as UpdateEntity, id: '2001', syncToken: '0' };
const read = (answer: UpdateAnswer, sent = PURCHASE) => readAnswer({ answer }, sent);
/** A 297 answer file as sendUpdate gives it: its status and body, and a tid when the test names one. */
const answerOf = (name: string, tid?: string): UpdateAnswer => {
  const { status, body } = file(name);
  return tid === undefined ? { status, data: body } : { status, data: body, intuit_tid: tid };
};
const fault = (code: unknown, rest: unknown[] = []) => ({ Fault: { Error: [{ Message: 'm', Detail: 'd', code, element: '' }, ...rest], type: 'ValidationFault' } });
const stored = (over: Record<string, unknown> = {}) => ({ ...file('answers/update-sent.json').body.Purchase, ...over });
const digits = (n: number) => '9'.repeat(n);

describe('step 1: a Fault 5010 is stale', () => {
  it('answers/stale.json (a 400)', () => {
    expect(read(answerOf('answers/stale.json'))).toStrictEqual({ kind: 'stale', code: '5010' });
  });
  it('a Fault 5010 in a 200 decides as in a 400: no status decides alone', () => {
    expect(read({ status: 200, data: fault('5010') })).toStrictEqual({ kind: 'stale', code: '5010' });
  });
  it('a Fault 5010 with a tid carries it', () => {
    expect(read(answerOf('answers/stale.json', 'fake-tid-0004'))).toStrictEqual({ kind: 'stale', code: '5010', tid: 'fake-tid-0004' });
  });
});

describe('step 2: a Fault 6200 or 6210 is closed', () => {
  it.each(['6200', '6210'])('%s in a 400', (code) => {
    expect(read({ status: 400, data: fault(code), intuit_tid: 'fake-tid-0003' })).toStrictEqual({ kind: 'closed', code, tid: 'fake-tid-0003' });
  });
  it('6210 in a 200', () => {
    expect(read({ status: 200, data: fault('6210') })).toStrictEqual({ kind: 'closed', code: '6210' });
  });
});

describe('step 3: any other Fault is failed, with its code and tid', () => {
  it('6000 with fake-tid-0002', () => {
    expect(read({ status: 400, data: fault('6000'), intuit_tid: 'fake-tid-0002' })).toStrictEqual({ kind: 'failed', code: '6000', tid: 'fake-tid-0002' });
  });
  it('a Fault in a 200, a 401 and a 500 alike', () => {
    for (const status of [200, 401, 500]) expect(read({ status, data: fault('6000') })).toStrictEqual({ kind: 'failed', code: '6000' });
  });
  it('a code of 64 pattern characters, underscore and dash included, is a Fault', () => {
    const code = 'A_b-9'.padEnd(64, 'x');
    expect(read({ status: 400, data: fault(code) })).toStrictEqual({ kind: 'failed', code });
  });
  it('only the first item’s code counts', () => {
    expect(read({ status: 400, data: fault('6000', [{ code: '5010' }]) })).toStrictEqual({ kind: 'failed', code: '6000' });
  });
});

describe('a Fault decides before an entity (steps 1-3 before 4 and 5)', () => {
  it('a 200 holding a Fault 6000 and the sent Purchase is failed, not stored', () => {
    expect(read({ status: 200, data: { ...fault('6000'), Purchase: stored() } })).toStrictEqual({ kind: 'failed', code: '6000' });
  });
  it('a 200 holding a Fault 5010 and another Id is stale, not id-mismatch', () => {
    expect(read({ status: 200, data: { ...fault('5010'), Purchase: stored({ Id: '1009' }) } })).toStrictEqual({ kind: 'stale', code: '5010' });
  });
});

describe('the Fault definition: a JSON object whose Fault.Error is a non-empty array whose first item has a string code', () => {
  // Each body below is no Fault, so steps 4-6 read it: with the sent Purchase beside it in a 200, it is stored.
  it.each([
    ['Error empty', { Fault: { Error: [] } }],
    ['code a number', fault(6000)],
    ['code missing', { Fault: { Error: [{ Message: 'm' }] } }],
    ['Error not an array', { Fault: { Error: { code: '6000' } } }],
    ['Fault not an object', { Fault: 'x' }],
    ['Fault an array', { Fault: [{ Error: [{ code: '6000' }] }] }],
    ['first item not an object', { Fault: { Error: ['6000'] } }],
  ])('%s: no Fault, so the stored entity decides', (_name, body) => {
    expect(read({ status: 200, data: { ...body, Purchase: stored() } })).toStrictEqual({ kind: 'stored', txn: stored() });
  });
  it('a body that is a JSON array holding a Fault is no Fault (no answer)', () => {
    expect(read({ status: 400, data: [fault('6000')] })).toStrictEqual({ kind: 'none' });
  });
});

describe('1.2: a Fault whose first code is off ^[A-Za-z0-9_-]{1,64}$ is no answer (step 6), whatever else the body holds', () => {
  it.each([
    ['a space', 'x y'],
    ['empty', ''],
    ['65 characters', 'A'.repeat(65)],
    ['a dot', '6000.1'],
    ['a newline', '6000\n'],
  ])('%s', (_name, code) => {
    expect(read({ status: 400, data: fault(code) })).toStrictEqual({ kind: 'none' });
  });
  it('even beside the sent Purchase in a 200: not stored', () => {
    expect(read({ status: 200, data: { ...fault('x y'), Purchase: stored() } })).toStrictEqual({ kind: 'none' });
  });
  it('even beside another Id in a 200: not id-mismatch', () => {
    expect(read({ status: 200, data: { ...fault('x y'), Purchase: stored({ Id: '1009' }) } })).toStrictEqual({ kind: 'none' });
  });
  it('its none keeps a valid tid (an unknown from a 4xx carries it, spec §3 T7)', () => {
    expect(read({ status: 400, data: fault('x y'), intuit_tid: 'fake-tid-0007' })).toStrictEqual({ kind: 'none', tid: 'fake-tid-0007' });
  });
  it('a later item’s valid code does not save it', () => {
    expect(read({ status: 400, data: fault('x y', [{ code: '5010' }]) })).toStrictEqual({ kind: 'none' });
  });
});

describe('step 4: a 2xx whose entity, as sent, has the sent Id is stored', () => {
  it('answers/update-sent.json: the stored Purchase', () => {
    expect(read(answerOf('answers/update-sent.json'))).toStrictEqual({ kind: 'stored', txn: stored() });
  });
  it('a Bill, sent as a bill', () => {
    const bill = { ...file('fetched/bill-2001.json').Bill, SyncToken: '1' };
    expect(read({ status: 200, data: { Bill: bill } }, BILL)).toStrictEqual({ kind: 'stored', txn: bill });
  });
  it('the other entity’s key is no entity: a Purchase answered to a bill is no answer', () => {
    expect(read({ status: 200, data: { Purchase: { ...stored(), Id: '2001' } } }, BILL)).toStrictEqual({ kind: 'none' });
  });
  it.each([200, 201, 299])('status %i is 2xx', (status) => {
    expect(read({ status, data: { Purchase: stored() } }).kind).toBe('stored');
  });
  it.each([199, 300, 304, 400, 500])('status %i is not: no answer', (status) => {
    expect(read({ status, data: { Purchase: stored() } })).toStrictEqual({ kind: 'none' });
  });
  it('a stored answer carries its tid', () => {
    expect(read(answerOf('answers/update-sent.json', 'fake-tid-0001'))).toStrictEqual({ kind: 'stored', txn: stored(), tid: 'fake-tid-0001' });
  });
  it('a 20-digit SyncToken is digits', () => {
    expect(read({ status: 200, data: { Purchase: stored({ SyncToken: digits(20) }) } }).kind).toBe('stored');
  });
});

describe('1.2: the sent Id with a SyncToken off ^[0-9]{1,20}$ is no answer (step 6), not stored', () => {
  it.each([
    ['a non-digit', '4a'],
    ['empty', ''],
    ['21 digits', digits(21)],
    ['a number', 4],
    ['null', null],
    ['a sign', '+4'],
  ])('%s', (_name, token) => {
    expect(read({ status: 200, data: { Purchase: stored({ SyncToken: token }) } })).toStrictEqual({ kind: 'none' });
  });
  it('a missing SyncToken', () => {
    const { SyncToken: _token, ...rest } = stored();
    expect(read({ status: 200, data: { Purchase: rest } })).toStrictEqual({ kind: 'none' });
  });
});

describe('step 5: a 2xx whose entity has another string Id is id-mismatch', () => {
  it('Id 1009', () => {
    expect(read({ status: 200, data: { Purchase: stored({ Id: '1009' }) }, intuit_tid: 'fake-tid-0006' })).toStrictEqual({
      kind: 'id-mismatch',
      tid: 'fake-tid-0006',
    });
  });
  it('whatever its SyncToken: a non-digit one stays id-mismatch', () => {
    expect(read({ status: 200, data: { Purchase: stored({ Id: '1009', SyncToken: 'x' }) } })).toStrictEqual({ kind: 'id-mismatch' });
  });
  it('a 3xx with another Id is no answer', () => {
    expect(read({ status: 302, data: { Purchase: stored({ Id: '1009' }) } })).toStrictEqual({ kind: 'none' });
  });
});

describe('step 6: anything else is no answer', () => {
  it.each([
    ['a 2xx with no entity', { status: 200, data: { time: 't' } }],
    ['a 2xx whose entity is a string', { status: 200, data: { Purchase: 'x' } }],
    ['a 2xx whose entity is an array', { status: 200, data: { Purchase: [stored()] } }],
    ['a 2xx whose entity is null', { status: 200, data: { Purchase: null } }],
    ['a 2xx whose entity has no Id', { status: 200, data: { Purchase: { SyncToken: '4' } } }],
    ['a 2xx whose entity has a number Id', { status: 200, data: { Purchase: stored({ Id: 1001 }) } }],
    ['a 2xx whose body isn’t JSON (text)', { status: 200, data: 'not json' }],
    ['a 2xx with an empty body', { status: 200, data: '' }],
    ['a 2xx with a null body', { status: 200, data: null }],
    ['a 401 with no body', { status: 401, data: '' }],
    ['a 429', { status: 429, data: 'Too Many Requests' }],
    ['a 500 with no Fault', { status: 500, data: { error: 'x' } }],
  ] as [string, UpdateAnswer][])('%s', (_name, answer) => {
    expect(read(answer)).toStrictEqual({ kind: 'none' });
  });
  it('a 500 with no Fault keeps its tid', () => {
    expect(read({ status: 500, data: '', intuit_tid: 'fake-tid-0005' })).toStrictEqual({ kind: 'none', tid: 'fake-tid-0005' });
  });
  it('no answer at all (a timeout, a reset, a guard refusal): none, with no tid', () => {
    for (const error of [new Error('timeout'), Object.assign(new Error('reset'), { code: 'ECONNRESET' }), undefined, null])
      expect(readAnswer({ error }, PURCHASE)).toStrictEqual({ kind: 'none' });
  });
});

describe('the tid: kept only when it matches §5’s ^[A-Za-z0-9-]{1,64}$ (contract §14 "as §5\'s")', () => {
  const tidOf = (tid: unknown) => read({ status: 400, data: fault('6000'), intuit_tid: tid as string });
  it('64 pattern characters are kept', () => {
    const tid = 'a-Z9'.padEnd(64, '0');
    expect(tidOf(tid)).toStrictEqual({ kind: 'failed', code: '6000', tid });
  });
  it.each([
    ['65 characters', 'a'.repeat(65)],
    ['empty', ''],
    ['a space', 'fake tid'],
    ['an underscore (not in §5’s pattern)', 'fake_tid'],
    ['a newline', 'fake-tid\n'],
    ['a number', 7],
  ])('%s is dropped', (_name, tid) => {
    expect(tidOf(tid)).toStrictEqual({ kind: 'failed', code: '6000' });
  });
  it('dropped from an id-mismatch and a none too', () => {
    expect(read({ status: 200, data: { Purchase: stored({ Id: '1009' }) }, intuit_tid: 'a b' })).toStrictEqual({ kind: 'id-mismatch' });
    expect(read({ status: 500, data: '', intuit_tid: 'a b' })).toStrictEqual({ kind: 'none' });
  });
});
