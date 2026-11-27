// Sanctuary Computer (quickbooks-mcp-294): the change flow's guards through the write server (spec DW1; contract 1.2 §15 steps 13-14, §17,
// §19 Off switch): nothing registered or sent unless the intent's answer is exactly ok (A1.4), `recorded` on each result (A1.10), one
// registration per attempt and a refused one sending nothing (A1.13), the switch, the size and their order, the re-check, the latch and a
// recreated switch (A1.14), a receipt after every post-send throw (A1.16, but the answer reader's and the renderer's, which
// change-throws.test.ts mocks), and a refusal with no §6 text never reaching freeText unchecked (TJ2).
import { describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { fakePath } from '../helpers/server.js';
import { categorizeTool } from '../../src/write/categorize.js';
import type { Registry } from '../../src/write/capability.js';
import { createKit } from '../../src/write/kit.js';
import { writeMode } from '../../src/write/mode.js';
import { forkReason } from '../../src/write/results.js';
import { ruleLines } from '../../src/write/rules.js';
import { SWITCH_STUCK_LINE } from '../../src/write/switch.js';
import { fixture, sharedId, type Json } from './derive.js';
import { STAMP_NOW, stubOf, world, writeRig, type World } from './write-rig.js';

jest.setTimeout(30000);
const rig = writeRig();

const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const toolCall = (): Json => JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_purchase.json'), 'utf8'));
const args = (params: Json = {}) => ({ name: 'qbo_categorize_purchase', arguments: { ...toolCall(), params: { ...toolCall().params, ...params } } });
const expected = (rel: string): Json => JSON.parse(readFileSync(fakePath(`tool-results/qbo_categorize_purchase/${rel}`), 'utf8'));
const withLine = (rel: string, after: string, line: string): Json => {
  const file = expected(rel);
  const lines = file.content[0].text.split('\n');
  lines.splice(lines.findIndex((l: string) => l.startsWith(`${after}: `)) + 1, 0, line);
  return { ...file, content: [{ type: 'text', text: lines.join('\n') }] };
};
const successWith = (rel: string, over: Json): Json => ({ content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(expected(rel).content[0].text), ...over }) }] });
const stored = () => stubOf(fixture('answers/update-sent.json'));
const storedAmount = () => stubOf(fixture('answers/stored-amount.json'));
const cmds = (w: World): string[] => w.fake.requests().map((r: any) => r.cmd);
const OK = { intent: ['intent-ok.json'], outcome: ['outcome-sent.json'] };
const errno = (code: string) => Object.assign(new Error(code), { code });

describe('A1.4: nothing registered or sent unless the intent answers exactly ok', () => {
  const other = (from: string, to: string) => KEY.replace(from, to);
  const cases: Array<[string, any, string]> = [
    ['not ok with this call’s key (intent-receipt-failed.json)', 'intent-receipt-failed.json', 'receipt-failed-appended.json'],
    ['not ok with another transaction’s key', { answer: { ok: false, reason: 'write:receipt-failed', cause: 'notion', key: other(':1001:', ':1002:') } }, 'receipt-failed.json'],
    ['not ok with a key that isn’t an attempt key', { answer: { ok: false, reason: 'write:receipt-failed', cause: 'notion', key: `${KEY}:intent` } }, 'receipt-failed.json'],
    ['write:cap (intent-cap-intents.json)', 'intent-cap-intents.json', 'cap.json'],
    ['not ok, no key', { answer: { ok: false, reason: 'write:receipt-failed', cause: 'lock' } }, 'receipt-failed.json'],
    ['bad-request (bad-request.json)', 'bad-request.json', 'receipt-failed.json'],
    ['exit 1', { misbehave: 'exit 1' }, 'receipt-failed.json'],
    ['no JSON', { misbehave: 'no-json' }, 'receipt-failed.json'],
    ['two JSON objects', { misbehave: 'two-json' }, 'receipt-failed.json'],
    ['stdout over 1 MiB', { misbehave: 'big 1100000' }, 'receipt-failed.json'],
    ['ok printed, then exit 2', { misbehave: 'ok-then-exit 2', value: { ok: true, key: KEY, n: 1 } }, 'receipt-failed.json'],
    ['ok "true"', { answer: { ok: 'true', key: KEY, n: 1 } }, 'receipt-failed.json'],
    ['ok 1', { answer: { ok: 1, key: KEY, n: 1 } }, 'receipt-failed.json'],
    ['{ ok: true } with no key', { answer: { ok: true, n: 1 } }, 'receipt-failed.json'],
    ['a key for another company', { answer: { ok: true, key: other('garden3d', 'index-space'), n: 1 } }, 'receipt-failed.json'],
    ['a key for another type', { answer: { ok: true, key: other('purchase', 'bill'), n: 1 } }, 'receipt-failed.json'],
    ['a key for another id', { answer: { ok: true, key: other(':1001:', ':1002:'), n: 1 } }, 'receipt-failed.json'],
    ['a key for another SyncToken', { answer: { ok: true, key: other(':3:', ':4:'), n: 1 } }, 'receipt-failed.json'],
    ['a key whose last part isn’t n', { answer: { ok: true, key: KEY, n: 2 } }, 'receipt-failed.json'],
    ['n missing', { answer: { ok: true, key: KEY } }, 'receipt-failed.json'],
    ['n not an integer', { answer: { ok: true, key: KEY, n: '1' } }, 'receipt-failed.json'],
    ['an extra key', { answer: { ok: true, key: KEY, n: 1, extra: true } }, 'receipt-failed.json'],
  ];
  it.each(cases)('%s: its result; no POST, registry size 0, no outcome', async (_label, step, rel) => {
    const w = world(rig, { intent: [step as any] });
    w.post = () => stored();
    const { client, mode } = await w.start();
    expect(await client.callTool(args())).toEqual(expected(rel));
    expect([rig.posts(), mode.registry.size, cmds(w)]).toEqual([[], 0, ['intent']]);
  });
  it('a command that exits before reading stdin, or one that doesn’t exist: receipt-failed.json, nothing sent', async () => {
    for (const env of ['close-stdin', 'enoent']) {
      const w = world(rig, env === 'close-stdin' ? { '*': [{ misbehave: 'close-stdin' }] } : {});
      if (env === 'enoent') w.env.QBO_WRITE_RECEIPT_CMD = `${w.dir}/no-such-command`;
      const { client, mode } = await w.start();
      expect(await client.callTool(args())).toEqual(expected('receipt-failed.json'));
      expect([rig.posts(), mode.registry.size]).toEqual([[], 0]);
      await rig.stop();
    }
  });
});

describe('A1.10: recorded, through the flow', () => {
  it.each<[string, any, Json]>([
    ['{ ok: true, notion: true }: notion', { answer: { ok: true, notion: true } }, expected('sent.json')],
    ['{ ok: true, notion: false }: ledger', { answer: { ok: true, notion: false } }, expected('sent-ledger-only.json')],
    ['not ok: none', { answer: { ok: false, reason: 'failed', cause: 'ledger' } }, expected('sent-recorded-none.json')],
    ['{ ok: true } with no notion: none', { answer: { ok: true } }, expected('sent-recorded-none.json')],
    ['a non-boolean notion: none', { answer: { ok: true, notion: 'yes' } }, expected('sent-recorded-none.json')],
    ['an extra key: none', { answer: { ok: true, notion: true, extra: 1 } }, expected('sent-recorded-none.json')],
  ])('a sent whose outcome answered %s', async (_label, answer, want) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [answer] });
    w.post = () => stored();
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(want);
  });
  it('a stale whose outcome answered notion false: recorded: ledger after receipt', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => stubOf(fixture('answers/stale.json'));
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(withLine('stale.json', 'receipt', 'recorded: ledger'));
  });
  it('a failed whose outcome was not ok: recorded: none after intuit_tid', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: false } }] });
    w.post = () => ({ status: 400, headers: { intuit_tid: 'fake-tid-0002' }, body: JSON.stringify({ Fault: { Error: [{ code: '6000' }] } }) });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(withLine('failed.json', 'intuit_tid', 'recorded: none'));
  });
  it('an unknown whose outcome reached the ledger only: recorded: ledger, the send sentence', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: false } }] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(withLine('unknown.json', 'receipt', 'recorded: ledger'));
  });
});

describe('A1.13: one registration per attempt (QA1)', () => {
  /** The server's own registry, register counted. */
  const counted = (mode: ReturnType<typeof writeMode>) => {
    const register = jest.fn((checked: any) => mode.registry.register(checked));
    const registry: Registry = { register, has: mode.registry.has, take: mode.registry.take, get size() {
      return mode.registry.size;
    } };
    return { register, tools: [categorizeTool('purchase', { registry, sw: mode.sw, kit: mode.kit }), ...mode.tools.slice(1)] };
  };
  it('register is called exactly once per attempt, after the intent’s ok, and the send uses it', async () => {
    const w = world(rig, OK);
    const mode = writeMode({ wall: () => STAMP_NOW });
    const { register, tools } = counted(mode);
    let atRegister: string[] = [];
    register.mockImplementationOnce((checked: any) => ((atRegister = cmds(w)), mode.registry.register(checked)));
    w.post = () => stored();
    const { client } = await w.start({}, { mode, tools });
    expect(await client.callTool(args())).toEqual(expected('sent.json'));
    expect(register).toHaveBeenCalledTimes(1);
    expect(atRegister).toEqual(['intent']);
    expect(mode.registry.size).toBe(0);
  });
  it('a registration refused (the check 60000 ms old by the registry’s clock): fork-error, no POST', async () => {
    const w = world(rig, { intent: ['intent-ok.json'] });
    let t = 0;
    w.onGet = (path) => {
      if (path === 'account/77') t = 60_000;
    };
    const { client, mode } = await w.start({ mono: () => t });
    expect(await client.callTool(args())).toEqual(forkReason({ reason: 'fork-error' }));
    expect([rig.posts(), mode.registry.size, cmds(w)]).toEqual([[], 0, ['intent']]);
  });
});

describe('A1.14: the switch, the size and their order', () => {
  it('the switch absent: disabled.json, nothing fetched, no command run', async () => {
    const w = world(rig, OK, { switchOn: false });
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(expected('disabled.json'));
    expect([rig.net.calls, w.fake.log()]).toEqual([[], []]);
  });
  it('the switch absent and a bad stamp: sweep.json (sweep before switch)', async () => {
    const w = world(rig, OK, { switchOn: false });
    writeFileSync(w.stampPath, '{');
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(expected('sweep.json'));
  });
  it('21 lines and a missing stamp: size.json (size first), nothing fetched', async () => {
    const w = world(rig, OK, { switchOn: false });
    rmSync(w.stampPath);
    const { client } = await w.start();
    expect(await client.callTool(args({ lines: Array.from({ length: 21 }, (_, i) => ({ line_id: String(i + 1), account_id: '84' })) }))).toEqual(expected('size.json'));
    expect(rig.net.calls).toEqual([]);
  });
  it('the switch deleted after the fetches, before the intent (S16): disabled.json, no intent, no POST', async () => {
    const w = world(rig, OK);
    w.onGet = (path) => {
      if (path === 'account/77') rmSync(w.switchPath);
    };
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(expected('disabled.json'));
    expect(rig.qbo().at(-1)).toBe('GET account/77');
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });
  it('a directory at the switch path is absent', async () => {
    const w = world(rig, OK, { switchOn: false });
    mkdirSync(w.switchPath);
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(expected('disabled.json'));
  });
  it('a stat failing EACCES (the fs seam) is absent, with the file present', async () => {
    const w = world(rig, OK);
    const real = createKit().fs;
    const { client } = await w.start({ fs: { stat: async () => Promise.reject(errno('EACCES')), unlink: real.unlink } });
    expect(await client.callTool(args())).toEqual(expected('disabled.json'));
    expect(existsSync(w.switchPath)).toBe(true);
  });
  it('a sent-diff whose unlink succeeds: writes_off true; the switch recreated, the next call sends (no latch)', async () => {
    const w = world(rig, { intent: ['intent-ok.json', { answer: { ok: true, key: KEY.replace(/1$/, '2'), n: 2 } }], outcome: ['outcome-sent.json', 'outcome-sent.json'] });
    w.post = (_c, n) => (n === 0 ? storedAmount() : stored());
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(successWith('sent-diff.json', { diff: ['Line:1'] }));
    expect(existsSync(w.switchPath)).toBe(false);
    writeFileSync(w.switchPath, '');
    expect(await client.callTool(args())).toEqual(successWith('sent.json', { receipt: KEY.replace(/1$/, '2') }));
  });
  it.each<[string, unknown]>([
    ['EACCES', errno('EACCES')],
    ['a throw of a non-errno value (V1, A1.16’s switch arm)', 'boom'],
  ])('a sent-diff whose unlink fails with %s: writes_off false, one stderr line, the next call disabled with the file present (the latch)', async (_label, thrown) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-sent.json'] });
    w.post = () => storedAmount();
    const real = createKit().fs;
    const { client } = await w.start({ fs: { stat: real.stat, unlink: async () => Promise.reject(thrown) } });
    expect(await client.callTool(args())).toEqual(successWith('sent-diff.json', { diff: ['Line:1'], writes_off: false }));
    expect((process.stderr.write as jest.Mock).mock.calls).toEqual([[SWITCH_STUCK_LINE]]);
    expect(existsSync(w.switchPath)).toBe(true);
    rig.net.calls.length = 0;
    expect(await client.callTool(args())).toEqual(expected('disabled.json'));
    expect(rig.net.calls).toEqual([]);
  });
  it('a sent-diff with the switch already gone (ENOENT): writes_off false, no latch; recreated, the next call sends', async () => {
    const w = world(rig, { intent: ['intent-ok.json', { answer: { ok: true, key: KEY.replace(/1$/, '2'), n: 2 } }], outcome: ['outcome-sent.json', 'outcome-sent.json'] });
    w.post = (_c, n) => {
      if (n > 0) return stored();
      rmSync(w.switchPath);
      return storedAmount();
    };
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(successWith('sent-diff.json', { diff: ['Line:1'], writes_off: false }));
    writeFileSync(w.switchPath, '');
    expect(await client.callTool(args())).toEqual(successWith('sent.json', { receipt: KEY.replace(/1$/, '2') }));
  });
});

describe('A1.16: after the send, always a receipt', () => {
  it('a throw in the forced token get: unknown.json, the unknown outcome asked', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 401, body: '' });
    const { client, runtime } = await w.start();
    const get = runtime.stacks.get.bind(runtime.stacks);
    jest.spyOn(runtime.stacks, 'get').mockImplementation((company, opts) => {
      if (opts?.force === true) throw new Error('forced get');
      return get(company, opts);
    });
    expect(await client.callTool(args())).toEqual(expected('unknown.json'));
    expect(cmds(w)).toEqual(['intent', 'outcome']);
    expect(rig.qbo().at(-1)).toBe('POST purchase');
  });
  it('a throw in the refetch (the stub network throws on that GET): unknown.json, the unknown outcome asked', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    w.post = () => ({ status: 500, body: '{}' });
    w.onGet = (path) => {
      if (path === 'purchase/1001' && rig.posts().length > 0) throw new Error('refetch');
    };
    const { client } = await w.start();
    expect(await client.callTool(args())).toEqual(expected('unknown.json'));
    expect(cmds(w)).toEqual(['intent', 'outcome']);
  });
  /** The kit's spawn, its first run (the intent) real and its second (the outcome) `then`. */
  const outcomeSpawn = (then: () => unknown) => {
    const real = createKit().spawn;
    let n = 0;
    return ((...a: Parameters<typeof real>) => (n++ === 0 ? real(...a) : then())) as typeof real;
  };
  const throwing = () => {
    throw new Error('spawn');
  };
  /** A child whose stdin throws as it is written: runReceipt's promise rejects. */
  const broken = () => ({ stdin: { on: () => undefined, end: throwing }, stdout: { on: () => undefined }, stderr: { on: () => undefined }, on: () => undefined, kill: () => undefined });
  it.each([
    ['throws', throwing],
    ['gives a child that throws as it is written', broken],
  ])('the outcome’s spawn %s: no answer gives unknown-recorded-none.json; a stored answer, sent with recorded none', async (_label, then) => {
    const w = world(rig, { intent: ['intent-ok.json', 'intent-ok.json'] });
    w.post = () => ({ status: 500, body: '{}' });
    const { client } = await w.start({ spawn: outcomeSpawn(then) });
    expect(await client.callTool(args())).toEqual(expected('unknown-recorded-none.json'));
    expect(cmds(w)).toEqual(['intent']);
    await rig.stop();
    const w2 = world(rig, { intent: ['intent-ok.json'] });
    w2.post = () => stored();
    const second = await w2.start({ spawn: outcomeSpawn(then) });
    expect(await second.client.callTool(args())).toEqual(expected('sent-recorded-none.json'));
  });
});

describe('TK6: the switch is turned off before the outcome is asked', () => {
  /** The kit's spawn, real, noting at each run whether the switch file is there. */
  const noting = (w: World, at: boolean[]) => {
    const real = createKit().spawn;
    return ((...a: Parameters<typeof real>) => (at.push(existsSync(w.switchPath)), real(...a))) as typeof real;
  };
  it('a sent-diff: on at the intent, gone at the outcome', async () => {
    const at: boolean[] = [];
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => storedAmount();
    const { client } = await w.start({ spawn: noting(w, at) });
    expect(await client.callTool(args())).toEqual(successWith('sent-diff.json', { diff: ['Line:1'] }));
    expect(at).toEqual([true, false]);
  });
  it('an id-mismatch, the refetch unmoved: on at the intent, gone at the outcome', async () => {
    const at: boolean[] = [];
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => stubOf(((f) => ((f.body.Purchase.Id = '1009'), f))(fixture('answers/update-sent.json')));
    const { client } = await w.start({ spawn: noting(w, at) });
    expect(JSON.stringify(await client.callTool(args()))).toContain('note: id-mismatch');
    expect(at).toEqual([true, false]);
  });
});

describe('task-8-1 TM1: step 6’s refetch stores only a copy holding every named line’s after values (§17 Settling)', () => {
  /** A categorize of line 1 (77 to 84, class 12) and line 2 (84 and class 12 to 91, class 13). */
  const two = () => args({ lines: [{ line_id: '1', account_id: '84', class_id: '12' }, { line_id: '2', account_id: '91', class_id: '13' }] });
  const detail = (account: string, klass: string) => ({ AccountRef: { value: account }, ClassRef: { value: klass } });
  /** No answer to the POST; the books then hold purchase 1001 at SyncToken 4 with the given lines' details. */
  const unanswered = (w: World, line1: Json, line2: Json) => {
    w.post = () => {
      const txn = fixture('fetched/purchase-1001.json');
      txn.Purchase.SyncToken = '4';
      txn.Purchase.Line[0].AccountBasedExpenseLineDetail = line1;
      txn.Purchase.Line[1].AccountBasedExpenseLineDetail = line2;
      w.books['purchase/1001'] = txn;
      return { status: 500, body: '{}' };
    };
  };
  it.each<[string, Json, Json]>([
    ['line 1 on its after values, line 2 still on 84 and class 12', detail('84', '12'), detail('84', '12')],
    ['line 2 on its after values, line 1 still on 77', { AccountRef: { value: '77' } }, detail('91', '13')],
  ])('moved with %s: unknown.json, the unknown outcome asked, one POST', async (_label, line1, line2) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: ['outcome-unknown.json'] });
    unanswered(w, line1, line2);
    const { client } = await w.start();
    expect(await client.callTool(two())).toEqual(expected('unknown.json'));
    expect(w.fake.requests()[1]).toMatchObject({ cmd: 'outcome', result: 'unknown' });
    expect(rig.posts()).toHaveLength(1);
  });
  it('moved with both lines on their after values: stored, sent with both lines', async () => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    unanswered(w, detail('84', '12'), detail('91', '13'));
    const { client } = await w.start();
    expect(await client.callTool(two())).toEqual(
      successWith('sent.json', {
        lines: [
          { line_id: '1', before: { account_id: '77', class_id: null }, after: { account_id: '84', class_id: '12' } },
          { line_id: '2', before: { account_id: '84', class_id: '12' }, after: { account_id: '91', class_id: '13' } },
        ],
      }),
    );
    expect(rig.posts()).toHaveLength(1);
  });
});

describe('task-8-2 TN1-TN3: step 6’s refetch reads any Fault before the entity, in any status, and the entity under the type sent (§17)', () => {
  const TIME = '2026-11-18T09:00:00.000-08:00';
  /** A GET answered `status` with `top`'s keys and the time. */
  const answered = (status: number, top: Json): Json => ({ answer: { status, body: JSON.stringify({ ...top, time: TIME }) } });
  const faultWith = (errors: unknown): Json => ({ Fault: { Error: errors, type: 'ValidationFault' } });
  const faultCoded = (code: unknown): Json => faultWith([{ Message: 'm', Detail: 'd', code }]);
  /** Purchase 1001 moved by one with the after values (update-sent.json's stored copy), and as fetched. */
  const moved = (): Json => fixture('answers/update-sent.json').body.Purchase;
  const unmoved = (): Json => fixture('fetched/purchase-1001.json').Purchase;
  /** An unanswered categorize of purchase 1001 whose refetch is `refetched`: the result, the outcomes asked, the POSTs. */
  const unanswered = async (refetched: Json) => {
    const w = world(rig, { intent: ['intent-ok.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => ((w.books['purchase/1001'] = refetched), { status: 500, body: '{}' });
    const { client } = await w.start();
    const result = await client.callTool(args());
    return { result, outcomes: w.fake.requests().filter((r: any) => r.cmd === 'outcome').map((r: any) => r.result), posts: rig.posts().length };
  };
  it.each<[string, Json]>([
    ['a 200 holding Fault 6000 beside the moved Purchase', answered(200, { ...faultCoded('6000'), Purchase: moved() })],
    ['a 200 holding Fault 6000 beside the unmoved Purchase', answered(200, { ...faultCoded('6000'), Purchase: unmoved() })],
    ['a 500 holding Fault 6000 beside the moved Purchase', answered(500, { ...faultCoded('6000'), Purchase: moved() })],
    ['a 404 holding Fault 6000 beside the moved Purchase', answered(404, { ...faultCoded('6000'), Purchase: moved() })],
    ['a 200 holding Fault 610 beside the moved Purchase', answered(200, { ...faultCoded('610'), Purchase: moved() })],
    ['a 200 whose first code is off §17’s pattern ("610 ") beside the moved Purchase', answered(200, { ...faultCoded('610 '), Purchase: moved() })],
    ['a 200 whose first code is off §17’s pattern ("") beside the moved Purchase', answered(200, { ...faultCoded(''), Purchase: moved() })],
    ['a 200 holding the moved copy under Bill', answered(200, { Bill: moved() })],
  ])('%s: unknown.json, the unknown outcome asked, one POST', async (_label, refetched) => {
    expect(await unanswered(refetched)).toEqual({ result: expected('unknown.json'), outcomes: ['unknown'], posts: 1 });
  });
  it.each<[string, Json]>([
    ['a first code that is the number 610', faultCoded(610)],
    ['a first code that is the number 6000', faultCoded(6000)],
    ['a first code that is null', faultCoded(null)],
    ['an empty Error array', faultWith([])],
    ['an Error that isn’t an array (an object with code 610)', faultWith({ Message: 'm', code: '610' })],
  ])('%s (no Fault) beside the moved Purchase in a 200: stored, sent.json, one POST', async (_label, top) => {
    expect(await unanswered(answered(200, { ...top, Purchase: moved() }))).toEqual({ result: expected('sent.json'), outcomes: ['sent'], posts: 1 });
  });
  // T9 TP1: only the first Error item's code counts (§17 "whose first item has a string `code`").
  it('T9 TP1: a first item whose code is the number 610, then one whose code is the string 6000 (no Fault), beside the moved Purchase in a 200: stored, sent.json', async () => {
    const top = faultWith([{ Message: 'm', code: 610 }, { Message: 'm', code: '6000' }]);
    expect(await unanswered(answered(200, { ...top, Purchase: moved() }))).toEqual({ result: expected('sent.json'), outcomes: ['sent'], posts: 1 });
  });
  // T9 TP2: the entity only in a 2xx (a 3xx is step 6's no answer), and only with the sent Id as a string.
  it.each<[string, Json]>([
    ['a 302 holding the moved Purchase', answered(302, { Purchase: moved() })],
    ['a 200 holding the moved Purchase with its Id the number 1001', answered(200, { Purchase: { ...moved(), Id: 1001 } })],
  ])('T9 TP2: %s is no transaction: unknown.json, the unknown outcome asked, one POST', async (_label, refetched) => {
    expect(await unanswered(refetched)).toEqual({ result: expected('unknown.json'), outcomes: ['unknown'], posts: 1 });
  });

  const BILL_KEY = 'quickbooks-write:garden3d:bill:2001:0:1';
  const bill = () => ({ name: 'qbo_categorize_bill', arguments: JSON.parse(readFileSync(fakePath('tool-calls/qbo_categorize_bill.json'), 'utf8')) });
  /** bill/2001 moved by one with line 1 on 91 (the call's after value). */
  const billMoved = (): Json => {
    const b = fixture('fetched/bill-2001.json').Bill;
    b.SyncToken = '1';
    b.Line[0].AccountBasedExpenseLineDetail.AccountRef.value = '91';
    return b;
  };
  it.each<[string, () => Json, Json]>([
    ['under Bill: stored, qbo_categorize_bill/sent.json', () => ({ Bill: billMoved(), time: TIME }), JSON.parse(readFileSync(fakePath('tool-results/qbo_categorize_bill/sent.json'), 'utf8'))],
    ['under Purchase: unknown with the bill receipt', () => ({ Purchase: billMoved(), time: TIME }), { content: [{ type: 'text', text: expected('unknown.json').content[0].text.replace(KEY, BILL_KEY) }], isError: true }],
  ])('a Bill categorize unanswered, the refetched bill/2001 moved with the after values %s', async (_label, refetched, want) => {
    const w = world(rig, { intent: ['intent-bill.json'], outcome: [{ answer: { ok: true, notion: true } }] });
    w.post = () => ((w.books['bill/2001'] = refetched()), { status: 500, body: '{}' });
    const { client } = await w.start();
    expect(await client.callTool(bill())).toEqual(want);
    expect(rig.qbo().slice(-2)).toEqual(['POST bill', 'GET bill/2001']);
  });
});

describe('TJ2: a refusal with no §6 text never reaches freeText unchecked', () => {
  it('ruleLines decides `none` before the fetched ids', () => {
    const txn = sharedId(fixture('fetched/purchase-1001.json')).Purchase;
    expect(ruleLines(txn, [])).toEqual({ reason: 'write:line', detail: { case: 'none' } });
    expect(ruleLines(txn, [{ line_id: '1' }])).toEqual({ reason: 'write:line', detail: { case: 'ids' } });
  });
  it('the handler given no lines (past the schema’s minItems): fork-error, nothing run or sent', async () => {
    const w = world(rig, OK);
    const { mode, runtime } = await w.start();
    const handler = mode.tools[0].handler;
    expect(await handler({ company: 'garden3d', params: { id: '1001', lines: [], reason: 'x' } }, runtime)).toEqual(forkReason({ reason: 'fork-error' }));
    expect([w.fake.log(), rig.posts()]).toEqual([[], []]);
  });
});
