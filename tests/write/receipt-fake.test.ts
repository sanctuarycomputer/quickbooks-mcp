// Sanctuary Computer (quickbooks-mcp-294): the fake receipt command (spec §4) answers as scripted, refuses what the real command's
// shape check refuses, accepts every receipt-cmd/ vector's request, and logs each run's request and environment.
import { spawnSync } from 'child_process';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { receiptFake, vector, type FakeScript } from './receipt-fake.js';

type Fake = ReturnType<typeof receiptFake>;
const fakes: Fake[] = [];
const make = (script: FakeScript = {}): Fake => {
  const fake = receiptFake(script);
  fakes.push(fake);
  return fake;
};
afterEach(() => {
  while (fakes.length > 0) fakes.pop()!.done();
});

const run = (fake: Fake, input: string, env: Record<string, string> = {}) => {
  const r = spawnSync(fake.argv[0], fake.argv.slice(1), { input, env, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout };
};
const ask = (fake: Fake, request: unknown) => JSON.parse(run(fake, JSON.stringify(request)).stdout);
const BAD = { ok: false, reason: 'bad-request', cause: 'bad-request' };

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
    for (const name of SHAPE_REFUSED) expect([name, ask(make(), vector(name).request)]).toEqual([name, vector(name).answer]);
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
  ];
  it.each(MUTATIONS)('refuses an intent with %s', (_name, mutate) => {
    const fake = make({ intent: [{ answer: { ok: true } }] });
    expect(ask(fake, mutate(intent()))).toEqual(BAD);
  });

  const OUTCOMES: Array<[string, (r: Record<string, any>) => unknown]> = [
    ['an off-pattern attempt key', (r) => ({ ...r, key: 'garden3d:purchase:1001:3:1' })],
    ['a diff name with a space', (r) => ({ ...r, result: 'sent-diff', diff: ['a b'] })],
    ['an unsorted diff', (r) => ({ ...r, result: 'sent-diff', diff: ['TotalAmt', 'Line:2'] })],
    ['a Fault code with a space', (r) => ({ ...r, result: 'failed', sync_token_after: null, error: { code: 'x y', intuit_tid: null } })],
    ['an intuit_tid with an underscore', (r) => ({ ...r, result: 'failed', sync_token_after: null, error: { code: '6000', intuit_tid: 'a_b' } })],
    ['an unknown result', (r) => ({ ...r, result: 'done' })],
  ];
  it.each(OUTCOMES)('refuses an outcome with %s', (_name, mutate) => {
    const fake = make({ outcome: [{ answer: { ok: true } }] });
    expect(ask(fake, mutate(outcome()))).toEqual(BAD);
  });

  it('refuses an unknown cmd, a non-object and no JSON at all, as the real one does', () => {
    const fake = make();
    expect(ask(fake, { cmd: 'delete', key: 'k' })).toEqual(BAD);
    expect(ask(fake, ['intent'])).toEqual(BAD);
    expect(JSON.parse(run(fake, 'not json').stdout)).toEqual(BAD);
  });

  it('accepts what the real one accepts: a key beyond the fields, and a lookup key it doesn’t pattern-check', () => {
    const fake = make({ intent: [{ answer: 'ok' }], lookup: [{ answer: 'ok' }] });
    expect(ask(fake, { ...intent(), extra: 1 })).toBe('ok');
    expect(ask(fake, { cmd: 'lookup', key: 'anything' })).toBe('ok');
  });

  it('logs each run’s request and whole environment', () => {
    const fake = make({ ping: [{ answer: { ok: true } }] });
    run(fake, '{"cmd":"ping"}', { QBO_WRITE_LEDGER: '/l', ONLY: 'this' });
    expect(fake.log()).toEqual([{ request: { cmd: 'ping' }, env: { QBO_WRITE_LEDGER: '/l', ONLY: 'this' } }]);
  });

  it.each([
    ['exit 1', { status: 1, stdout: '' }],
    ['no-json', { status: 0, stdout: 'not json\n' }],
    ['two-json', { status: 0, stdout: '{"ok":true}\n{"ok":true}\n' }],
    ['big 5', { status: 0, stdout: 'xxxxx' }],
    ['sleep 50', { status: 0, stdout: '' }],
  ])('misbehaves as scripted: %s', (misbehave, expected) => {
    const fake = make({ ping: [{ misbehave }] });
    expect(run(fake, '{"cmd":"ping"}')).toEqual(expected);
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
      const fake = receiptFake({ intent: [{ answer: 'a' }, { answer: 'b' }] });
      const bad = { ...intent(), digests: Object.fromEntries(Object.entries(intent().digests).reverse()) };
      fake.malformed(bad);
      ask(fake, intent());
      ask(fake, bad);
      fake.done();
      expect(readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        { request: intent(), malformed: false },
        { request: bad, malformed: true },
      ]);
    } finally {
      if (before === undefined) delete process.env.RECEIPT_REPLAY_LOG;
      else process.env.RECEIPT_REPLAY_LOG = before;
    }
  });
});
