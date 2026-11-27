// Sanctuary Computer (quickbooks-mcp-294): the fake receipt command (spec §4) answers as scripted, refuses what the real command's
// shape check refuses, accepts every receipt-cmd/ vector's request, and logs each run's request and environment.
// Every request this file sends malformed on purpose goes through `refused`, which marks it first, so A4.4's replay (plan T9) expects the
// real command's bad-request for it (task-2-1 TB1). Each shape rule has a refused case that differs from an accepted request in that rule
// alone (TB3); rules no request can reach (lineValid's key count, key types and key parts, m under 1) are named in the fake's header.
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { receiptFake, vector, type FakeScript } from './receipt-fake.js';

type Fake = ReturnType<typeof receiptFake>;
// receiptFake registers its own afterEach cleanup (TB5).
const make = (script: FakeScript = {}): Fake => receiptFake(script);

const run = (fake: Fake, input: string, env: Record<string, string> = {}) => {
  const r = spawnSync(fake.argv[0], fake.argv.slice(1), { input, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout };
};
const ask = (fake: Fake, request: unknown) => JSON.parse(run(fake, JSON.stringify(request)).stdout);
const BAD = { ok: false, reason: 'bad-request', cause: 'bad-request' };
/** Sends a request the test means to be malformed, marked so first. */
const refused = (fake: Fake, request: unknown) => {
  fake.malformed(request);
  return ask(fake, request);
};
type Req = Record<string, any>;
const sortKeys = (d: Record<string, string>) => Object.fromEntries(Object.entries(d).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const HEX = 'a'.repeat(64);
/** The intent with its one line changed by `f`. */
const line = (f: (l: Req) => Req) => (r: Req) => ({ ...r, lines: [f(structuredClone(r.lines[0]))] });
const side = (which: 'before' | 'after', over: Req) => line((l) => ({ ...l, [which]: { ...l[which], ...over } }));
const digests = (f: (d: Record<string, string>) => Record<string, string>) => (r: Req) => ({ ...r, digests: f({ ...r.digests }) });
const failed = (error: unknown) => (r: Req) => ({ ...r, result: 'failed', sync_token_after: null, error });

const WITH_REQUEST = readdirSync(fileURLToPath(new URL('../fakes/receipt-cmd/', import.meta.url))).filter((name) => 'request' in vector(name));
/** The vector the real command refuses for its shape. outcome-unknown-key.json and outcome-id-mismatch-m2.json are refused too, but
 * for the ledger they meet (no such key; id-mismatch past m 1), which the shape check doesn't see: the fake accepts them. */
const SHAPE_REFUSED = ['bad-request.json'];
const VECTOR_NAMES = WITH_REQUEST.filter((name) => !SHAPE_REFUSED.includes(name));
const intent = (): Record<string, any> => vector('intent-ok.json').request;
const outcome = (): Record<string, any> => vector('outcome-sent.json').request;

describe('the fake receipt command', () => {
  it.each(VECTOR_NAMES)('accepts %s’s request', (name) => {
    const req = vector(name).request;
    const fake = make({ [req.cmd]: [{ answer: { ok: true, marker: name } }] });
    expect(ask(fake, req)).toEqual({ ok: true, marker: name });
  });

  it('refuses each vector the real one refuses for its shape, as it does', () => {
    expect(SHAPE_REFUSED.length).toBeGreaterThan(0);
    for (const name of SHAPE_REFUSED) expect([name, refused(make(), vector(name).request)]).toEqual([name, vector(name).answer]);
  });

  it('answers a vector’s answer by its file name, then the next in the list', () => {
    const fake = make({ intent: ['intent-ok.json', 'intent-receipt-failed.json'] });
    expect(ask(fake, intent())).toEqual(vector('intent-ok.json').answer);
    expect(ask(fake, intent())).toEqual(vector('intent-receipt-failed.json').answer);
    expect(ask(fake, intent())).toEqual({ ok: false, reason: 'failed', cause: 'script-exhausted' });
  });

  it('counts each cmd on its own', () => {
    const fake = make({ intent: [{ answer: 'i1' }], outcome: [{ answer: 'o1' }, { answer: 'o2' }] });
    expect([ask(fake, outcome()), ask(fake, intent()), ask(fake, outcome())]).toEqual(['o1', 'i1', 'o2']);
  });

  const MUTATIONS: Array<[string, (r: Record<string, any>) => unknown]> = [
    ['unsorted digests', (r) => ({ ...r, digests: Object.fromEntries(Object.entries(r.digests).reverse()) })],
    ['a missing field', (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'reason'))],
    ['sync_token a number', (r) => ({ ...r, sync_token: 3 })],
    ['an id of 21 digits', (r) => ({ ...r, id: '1'.repeat(21) })],
    ['a non-hex digest', (r) => ({ ...r, digests: { ...r.digests, Id: 'A'.repeat(64) } })],
    ['a digest missing a named line', (r) => ({ ...r, digests: Object.fromEntries(Object.entries(r.digests).filter(([k]) => k !== 'Line:1')) })],
    ['a side with an extra key', (r) => ({ ...r, lines: [{ ...r.lines[0], after: { ...r.lines[0].after, x: 1 } }] })],
    ['undo_of off the attempt pattern', (r) => ({ ...r, undo_of: 'quickbooks-write:garden3d:purchase:1001:3:x' })],
    ['an unknown company', (r) => ({ ...r, company: 'acme' })],
    ['an unknown type', (r) => ({ ...r, type: 'invoice' })],
    ['lines not an array', (r) => ({ ...r, lines: r.lines[0] })],
    ['a reason not a string', (r) => ({ ...r, reason: 7 })],
    ['undo_of not a string', (r) => ({ ...r, undo_of: 7 })],
    ...(['SyncToken', 'MetaData', 'sparse', 'Line:'] as const).map(
      (k): [string, (r: Req) => unknown] => [`a banned digest key ${k}`, digests((d) => sortKeys({ ...d, [k]: HEX }))],
    ),
    ['digests with no Line', digests((d) => (delete d.Line, d))],
    ['a digest that is not a string', digests((d) => ({ ...d, Id: 7 as unknown as string }))],
    ['a digest that is an array holding the hex (the regex alone would pass it)', digests((d) => ({ ...d, Id: [HEX] as unknown as string }))],
    ['a digest of 63 hex digits', digests((d) => ({ ...d, Id: HEX.slice(1) }))],
    ['a side value mistyped', side('after', { account_name: 7 })],
    ['a side missing a key', line((l) => (delete l.after.class_name, l))],
    ['a before side that is not an object', line((l) => ({ ...l, before: null }))],
    ['account_id off the id pattern', side('after', { account_id: 'a84' })],
    ['account_id of 21 digits (ID’s length, which no key pattern decides here)', side('after', { account_id: '1'.repeat(21) })],
    ['class_id off the id pattern', side('before', { class_id: '1.2', class_name: 'x' })],
    ['line_id off the id pattern (its digest present)', (r) => digests((d) => sortKeys({ ...d, 'Line:x': HEX }))(line((l) => ({ ...l, line_id: 'x' }))(r))],
    ['a line change with an extra key', line((l) => ({ ...l, extra: 1 }))],
    ['a line change with no line_id', line((l) => (delete l.line_id, l))],
  ];
  it.each(MUTATIONS)('refuses an intent with %s', (_name, mutate) => {
    const fake = make({ intent: [{ answer: { ok: true } }] });
    expect(refused(fake, mutate(intent()))).toEqual(BAD);
  });

  const INTENT_TWINS: Array<[string, (r: Req) => unknown]> = [
    ['an undo_of on the attempt pattern', (r) => ({ ...r, undo_of: 'quickbooks-write:garden3d:purchase:1001:2:1' })],
    ['a class_id on the pattern', side('before', { class_id: '12', class_name: 'x' })],
    ['a null class on both sides', (r) => side('after', { class_id: null, class_name: null })(r)],
    ['a line_id of 20 digits, its digest present', (r) => digests((d) => sortKeys({ ...(delete d['Line:1'], d), ['Line:' + '9'.repeat(20)]: HEX }))(line((l) => ({ ...l, line_id: '9'.repeat(20) }))(r))],
    ['a digest key that only starts like a banned one', digests((d) => sortKeys({ ...d, SyncTokenX: HEX }))],
    ['a bill', (r) => ({ ...r, type: 'bill' })],
  ];
  it.each(INTENT_TWINS)('accepts an intent with %s', (_name, mutate) => {
    const fake = make({ intent: [{ answer: 'ok' }] });
    expect(ask(fake, mutate(intent()))).toBe('ok');
  });

  const OUTCOMES: Array<[string, (r: Record<string, any>) => unknown]> = [
    ['an off-pattern attempt key', (r) => ({ ...r, key: 'garden3d:purchase:1001:3:1' })],
    ['a diff name with a space', (r) => ({ ...r, result: 'sent-diff', diff: ['a b'] })],
    ['an unsorted diff', (r) => ({ ...r, result: 'sent-diff', diff: ['TotalAmt', 'Line:2'] })],
    ['a Fault code with a space', (r) => ({ ...r, result: 'failed', sync_token_after: null, error: { code: 'x y', intuit_tid: null } })],
    ['an intuit_tid with an underscore', (r) => ({ ...r, result: 'failed', sync_token_after: null, error: { code: '6000', intuit_tid: 'a_b' } })],
    ['an unknown result', (r) => ({ ...r, result: 'done' })],
    ['a result not a string', (r) => ({ ...r, result: 1 })],
    ['sync_token_after off the id pattern', (r) => ({ ...r, sync_token_after: '4a' })],
    ['a sent-diff with a null diff', (r) => ({ ...r, result: 'sent-diff' })],
    ['a sent-diff with an empty diff', (r) => ({ ...r, result: 'sent-diff', diff: [] })],
    ['a diff on a sent', (r) => ({ ...r, diff: ['TotalAmt'] })],
    ['a diff entry not a string', (r) => ({ ...r, result: 'sent-diff', diff: [1] })],
    ['an error on a sent', (r) => ({ ...r, error: { code: '6000', intuit_tid: null } })],
    ['an error with an extra key', failed({ code: '6000', intuit_tid: null, x: 1 })],
    ['an error with no intuit_tid', failed({ code: '6000' })],
    ['an error code not a string', failed({ code: 6000, intuit_tid: null })],
    ['an intuit_tid not a string', failed({ code: '6000', intuit_tid: 5 })],
    ['an unknown note', (r) => ({ ...r, note: 'other' })],
    ['a missing field', (r) => (delete r.note, r)],
  ];
  it.each(OUTCOMES)('refuses an outcome with %s', (_name, mutate) => {
    const fake = make({ outcome: [{ answer: { ok: true } }] });
    expect(refused(fake, mutate(outcome()))).toEqual(BAD);
  });

  const OUTCOME_TWINS: Array<[string, (r: Req) => unknown]> = [
    ['a sorted sent-diff', (r) => ({ ...r, result: 'sent-diff', diff: ['Line:2', 'TotalAmt'] })],
    ['a failed with an error and a null intuit_tid', failed({ code: '6000', intuit_tid: null })],
    ['a failed with an intuit_tid of letters, digits and dashes', failed({ code: 'A_b-1', intuit_tid: 'abc-1-XYZ' })],
    ['a failed with no error', failed(null)],
    ...(['id-mismatch', 'edited-since', 'deleted'] as const).map((note): [string, (r: Req) => unknown] => [`note ${note}`, (r) => ({ ...r, note })]),
    ['a null sync_token_after', (r) => ({ ...r, result: 'unknown', sync_token_after: null })],
  ];
  it.each(OUTCOME_TWINS)('accepts an outcome with %s', (_name, mutate) => {
    const fake = make({ outcome: [{ answer: 'ok' }] });
    expect(ask(fake, mutate(outcome()))).toBe('ok');
  });

  it.each<[string, unknown]>([
    ['an unknown cmd', { cmd: 'delete', key: 'k' }],
    ['a non-object', ['intent']],
    ['a cmd not a string', { cmd: ['ping'] }],
    ['a lookup with no key', { cmd: 'lookup' }],
    ['a lookup with a key not a string', { cmd: 'lookup', key: 1 }],
    ['a pending with no company', { cmd: 'pending' }],
    ['a pending with a company not a string', { cmd: 'pending', company: 1 }],
  ])('refuses %s, as the real one does', (_name, request) => {
    const fake = make({ lookup: [{ answer: 'ok' }], pending: [{ answer: 'ok' }], ping: [{ answer: 'ok' }] });
    expect(refused(fake, request)).toEqual(BAD);
  });

  it('refuses no JSON at all, and stdin over 1 MiB (as readStdin does), without logging a request to replay', () => {
    const fake = make({ ping: [{ answer: 'ok' }] });
    expect(JSON.parse(run(fake, 'not json').stdout)).toEqual(BAD);
    expect(JSON.parse(run(fake, JSON.stringify({ cmd: 'ping', pad: ' '.repeat(1 << 20) })).stdout)).toEqual(BAD);
    expect(fake.requests()).toEqual([null, null]);
  });

  it('accepts a pending with a company, a ping, and stdin of exactly 1 MiB', () => {
    const fake = make({ pending: [{ answer: 'p' }], ping: [{ answer: 'q' }] });
    expect(ask(fake, { cmd: 'pending', company: 'garden3d' })).toBe('p');
    const text = JSON.stringify({ cmd: 'ping', pad: '' });
    expect(JSON.parse(run(fake, JSON.stringify({ cmd: 'ping', pad: ' '.repeat((1 << 20) - text.length) })).stdout)).toBe('q');
  });

  it('a refused request uses up no script step: the next good request of that cmd gets the first answer (TB6)', () => {
    const fake = make({ intent: [{ answer: 'first' }, { answer: 'second' }] });
    expect(refused(fake, { ...intent(), reason: 7 })).toEqual(BAD);
    expect(ask(fake, intent())).toBe('first');
    expect(ask(fake, intent())).toBe('second');
  });

  // Ruling d-20261127-050429169: the fake follows the real check on extra keys (write-receipt.mjs:202-210, contract §20). These go unmarked,
  // so A4.4's replay (plan T9) holds the real command to accepting them too.
  it('accepts what the real one accepts: a key beyond the fields (intent and outcome), and a lookup key it doesn’t pattern-check', () => {
    const fake = make({ intent: [{ answer: 'ok' }], outcome: [{ answer: 'ok' }], lookup: [{ answer: 'ok' }] });
    expect(ask(fake, { ...intent(), extra: 1 })).toBe('ok');
    expect(ask(fake, { ...outcome(), extra: 1 })).toBe('ok');
    expect(ask(fake, { cmd: 'lookup', key: 'anything' })).toBe('ok');
  });

  // On win32 libuv adds its own keys (SYSTEMROOT and others) to every child, so the exact list is Linux-only (ruling d-20261127-044022509).
  (process.platform === 'win32' ? it.skip : it)('linux only (exact list): logs each run’s request and whole environment', () => {
    const fake = make({ ping: [{ answer: { ok: true } }] });
    run(fake, '{"cmd":"ping"}', { QBO_WRITE_LEDGER: '/l', ONLY: 'this' });
    expect(fake.log()).toEqual([{ request: { cmd: 'ping' }, env: { QBO_WRITE_LEDGER: '/l', ONLY: 'this' }, refused: false }]);
  });
  it('every platform: logs each run’s request and the keys it was given', () => {
    const fake = make({ ping: [{ answer: { ok: true } }] });
    run(fake, '{"cmd":"ping"}', { QBO_WRITE_LEDGER: '/l', ONLY: 'this' });
    const [entry] = fake.log();
    expect([entry.request, entry.env.QBO_WRITE_LEDGER, entry.env.ONLY]).toEqual([{ cmd: 'ping' }, '/l', 'this']);
  });

  it.each([
    ['exit 1', { status: 1, stdout: '' }],
    ['no-json', { status: 0, stdout: 'not json\n' }],
    ['two-json', { status: 0, stdout: '{"ok":true}\n{"ok":true}\n' }],
    ['big 5', { status: 0, stdout: 'xxxxx' }],
  ])('misbehaves as scripted: %s', (misbehave, expected) => {
    const fake = make({ ping: [{ misbehave }] });
    expect(run(fake, '{"cmd":"ping"}')).toEqual(expected);
  });

  it('sleeps as scripted: sleep 300 takes at least 300 ms against sleep 0 (TB9)', () => {
    const fake = make({ ping: [{ misbehave: 'sleep 300' }] });
    const t0 = Date.now();
    expect(run(fake, '{"cmd":"ping"}')).toEqual({ status: 0, stdout: '' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
  });

  it('prints an ok answer and then exits non-zero, and prints raw text', () => {
    const fake = make({ ping: [{ misbehave: 'ok-then-exit 2', value: { ok: true } }, { misbehave: 'raw', text: '[]' }] });
    expect(run(fake, '{"cmd":"ping"}')).toEqual({ status: 2, stdout: '{"ok":true}\n' });
    expect(run(fake, '{"cmd":"ping"}')).toEqual({ status: 0, stdout: '[]' });
  });

  it('exits before reading stdin when told to, logging no request', () => {
    const fake = make({ '*': [{ misbehave: 'close-stdin' }] });
    expect(run(fake, '{"cmd":"ping"}')).toEqual({ status: 0, stdout: '' });
    expect(fake.requests()).toEqual([null]);
  });

  it('done() hands every logged request to RECEIPT_REPLAY_LOG with its mark', () => {
    const out = `${make().dir}/replay.jsonl`;
    const before = process.env.RECEIPT_REPLAY_LOG;
    process.env.RECEIPT_REPLAY_LOG = out;
    try {
      writeFileSync(out, '');
      const fake = receiptFake({ intent: [{ answer: 'a' }, { answer: 'b' }], outcome: [{ answer: 'c' }] });
      const bad = MUTATIONS[0][1](intent());
      const badOutcome = OUTCOMES[0][1](outcome());
      ask(fake, intent());
      refused(fake, bad);
      refused(fake, badOutcome);
      ask(fake, outcome());
      run(fake, 'not json');
      fake.done();
      fake.done();
      expect(readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([
        { request: intent(), malformed: false },
        { request: bad, malformed: true },
        { request: badOutcome, malformed: true },
        { request: outcome(), malformed: false },
      ]);
    } finally {
      if (before === undefined) delete process.env.RECEIPT_REPLAY_LOG;
      else process.env.RECEIPT_REPLAY_LOG = before;
    }
  });
});
