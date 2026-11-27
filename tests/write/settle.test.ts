// Sanctuary Computer (quickbooks-mcp-294): spec A1.11 and A1.12, contract 1.2 §17 Settling: `settle` row by row from the receipt-cmd/
// vectors' ledgers and a stubbed reread only, and `applySettled` asking for the outcome through the fake receipt command, each settled
// request compared as text with its vector, and turning the switch off on a settled sent-diff only (V6). Then the sequences, each lookup
// built from one ledger. The undo and write-check flows that call these are T8's and 298's.
import { afterAll, describe, expect, it, jest } from '@jest/globals';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { WriteConfig } from '../../src/clients/config.js';
import { lookupOk, type Lookup } from '../../src/write/answers.js';
import { createKit } from '../../src/write/kit.js';
import type { Spawn } from '../../src/write/receipt-cmd.js';
import { applySettled, settle, type Reread, type Settled } from '../../src/write/settle.js';
import { createSwitch, type Switch } from '../../src/write/switch.js';
import { receiptFake, vector, type FakeScript } from './receipt-fake.js';

const TXNS = join(dirname(fileURLToPath(import.meta.url)), '..', 'fakes', 'transactions');
const txnFile = (name: string): Record<string, any> => JSON.parse(readFileSync(join(TXNS, name), 'utf8'));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const NOW = Date.parse('2026-11-18T15:00:00.000Z');
const MIN = 60_000;

// The refetched copies (Purchase 1001, built on SyncToken 3, line 1 to 84 / 12).
const UNMOVED = () => txnFile('fetched/purchase-1001.json').Purchase; // SyncToken 3, line 1 still 77
const MOVED_ONE = () => txnFile('answers/update-sent.json').body.Purchase; // SyncToken 4, the after values
const MOVED_ONE_AMOUNT = () => txnFile('answers/stored-amount.json').body.Purchase; // SyncToken 4, the after values, line 1's Amount 101
const MOVED_TWO = () => txnFile('refetch/purchase-1001-moved-by-two.json').Purchase; // SyncToken 5, the after values
const txn = (t: Record<string, unknown>): Reread => ({ kind: 'txn', txn: t });
const lineOne = (t: Record<string, any>) => t.Line.find((line: any) => line.Id === '1');

/** A vector's lookup or pending entry through the strict reader, as the flows read it. */
const lookupOf = (entry: Record<string, any>): Lookup => {
  const { intent, outcome, superseded_by, superseded_ahead } = entry;
  const read = lookupOk({ ok: true, intent, outcome, superseded_by, superseded_ahead }, intent.key, 'garden3d');
  if (read === null) throw new Error('the entry is not a valid lookup');
  return read;
};
/** The vector's ledger as one lookup of KEY: its intent and latest outcome, superseded by nothing. */
const ledgerLookup = (name: string): Lookup => {
  const ledger = vector(name).ledger;
  const outcomes = ledger.filter((l: any) => l.kind === 'outcome' && l.key === KEY);
  return lookupOf({ intent: ledger[0], outcome: outcomes.at(-1) ?? null, superseded_by: null, superseded_ahead: null });
};
/** outcome-settled-unknown.json's ledger: intent at 14:00, an unknown outcome at 14:30. */
const UNKNOWN = () => ledgerLookup('outcome-settled-unknown.json');
/** outcome-settled-failed.json's ledger: an intent at 14:00 and no outcome. */
const NO_OUTCOME = () => ledgerLookup('outcome-settled-failed.json');

type Deps = { reread: () => Promise<Reread>; wall: () => number };
const deps = (reread: Reread | (() => Promise<Reread>), now = NOW) => {
  const fn = jest.fn(typeof reread === 'function' ? reread : async () => reread);
  return { fn, deps: Object.freeze({ reread: fn, wall: () => now }) as Deps };
};
const run = async (attempt: Lookup, reread: Reread | (() => Promise<Reread>), now = NOW) => {
  const d = deps(reread, now);
  return { got: await settle(attempt, d.deps), calls: d.fn.mock.calls.length };
};
const settled = (result: Settled['result'], over: Partial<Settled> = {}): Settled => ({ result, sync_token_after: null, diff: null, note: null, ...over });

describe('settle, row 1: the age, from the unknown outcome’s at, else the intent’s', () => {
  const at1430 = Date.parse('2026-11-18T14:30:00.000Z');
  it('9:59.999 after the unknown outcome waits, with no reread (39:59.999 after its intent: the outcome’s at counts)', async () => {
    expect(await run(UNKNOWN(), txn(MOVED_ONE()), at1430 + 10 * MIN - 1)).toEqual({ got: 'wait', calls: 0 });
  });
  it('10:00.000 after it settles', async () => {
    expect(await run(UNKNOWN(), txn(MOVED_ONE()), at1430 + 10 * MIN)).toEqual({ got: settled('sent', { sync_token_after: '4' }), calls: 1 });
  });
  const at1400 = Date.parse('2026-11-18T14:00:00.000Z');
  it('with no outcome, 9:59.999 after the intent waits', async () => {
    expect(await run(NO_OUTCOME(), txn(UNMOVED()), at1400 + 10 * MIN - 1)).toEqual({ got: 'wait', calls: 0 });
  });
  it('with no outcome, 10:00.000 after the intent settles', async () => {
    expect(await run(NO_OUTCOME(), txn(UNMOVED()), at1400 + 10 * MIN)).toEqual({ got: settled('failed'), calls: 1 });
  });
  it('an at in the future (a negative age) waits', async () => {
    expect(await run(UNKNOWN(), txn(MOVED_ONE()), at1430 - 1)).toEqual({ got: 'wait', calls: 0 });
  });
  it('row 1 comes before row 2: a superseded attempt under 10 minutes waits', async () => {
    const a = { ...UNKNOWN(), superseded_by: `${KEY.slice(0, -1)}2`, superseded_ahead: 0 };
    expect(await run(a, txn(MOVED_ONE()), at1430 + 10 * MIN - 1)).toEqual({ got: 'wait', calls: 0 });
  });
  it.each([
    ['the outcome’s at fails the round trip (no millis)', (a: Lookup) => ({ ...a, outcome: { ...a.outcome!, at: '2026-11-18T14:30:00Z' } })],
    ['the outcome’s at isn’t a time', (a: Lookup) => ({ ...a, outcome: { ...a.outcome!, at: 'x' } })],
  ])('%s: no age, so it stays unknown, with no reread', async (_name, edit) => {
    expect(await run(edit(UNKNOWN()), txn(MOVED_ONE()))).toEqual({ got: 'stays', calls: 0 });
  });
  it('with no outcome, an intent at failing the test: no age, stays unknown', async () => {
    const a = NO_OUTCOME();
    expect(await run({ ...a, intent: { ...a.intent, at: '2026-11-18T14:00:00Z' } }, txn(UNMOVED()))).toEqual({ got: 'stays', calls: 0 });
  });
  it('with an unknown outcome, only its at counts: a bad intent at doesn’t stop it', async () => {
    const a = UNKNOWN();
    expect((await run({ ...a, intent: { ...a.intent, at: 'x' } }, txn(MOVED_ONE()))).got).toEqual(settled('sent', { sync_token_after: '4' }));
  });
  it('an attempt whose latest outcome isn’t unknown isn’t settled: it stays, with no reread', async () => {
    expect(await run(lookupOf(vector('lookup-ok.json').answer), txn(MOVED_ONE()))).toEqual({ got: 'stays', calls: 0 });
  });
});

describe('settle, rows 2-4: superseded, decided from the ledger alone (no reread)', () => {
  const pending = (name: string) => vector(name).answer.intents[0];
  it('row 2: ahead 0 (pending-superseded-same-token.json’s :1, its outcome unknown): failed', async () => {
    expect(await run(lookupOf(pending('pending-superseded-same-token.json')), txn(MOVED_ONE()))).toEqual({ got: settled('failed'), calls: 0 });
  });
  it('row 2: the same entry with its outcome removed: failed', async () => {
    expect(await run(lookupOf({ ...pending('pending-superseded-same-token.json'), outcome: null }), txn(MOVED_ONE()))).toEqual({
      got: settled('failed'),
      calls: 0,
    });
  });
  it('row 3: ahead 1 (pending-superseded-later-intent.json): failed', async () => {
    expect(await run(lookupOf(pending('pending-superseded-later-intent.json')), txn(MOVED_ONE()))).toEqual({ got: settled('failed'), calls: 0 });
  });
  it('row 4: ahead 2 (lookup-superseded.json): unsettled', async () => {
    expect(await run(lookupOf(vector('lookup-superseded.json').answer), txn(MOVED_ONE()))).toEqual({ got: settled('unsettled'), calls: 0 });
  });
  it('row 4: ahead 7: unsettled', async () => {
    expect(await run({ ...UNKNOWN(), superseded_by: 'quickbooks-write:garden3d:purchase:1001:10:1', superseded_ahead: 7 }, txn(MOVED_ONE()))).toEqual({
      got: settled('unsettled'),
      calls: 0,
    });
  });
});

describe('settle, rows 5-6: the reread fails', () => {
  it('row 5: Fault 610: unsettled, note deleted', async () => {
    expect(await run(UNKNOWN(), { kind: 'fault', code: '610' })).toEqual({ got: settled('unsettled', { note: 'deleted' }), calls: 1 });
  });
  it.each([
    ['another Fault', { kind: 'fault', code: '6000' } as Reread],
    ['a Fault 6100', { kind: 'fault', code: '6100' } as Reread],
    ['no answer, a 5xx, a timeout or a 1.0 fork reason (a prepare failure)', { kind: 'failed' } as Reread],
  ])('row 6: %s: stays unknown', async (_name, reread) => {
    expect(await run(UNKNOWN(), reread)).toEqual({ got: 'stays', calls: 1 });
  });
  it('row 6: a reread that throws: stays unknown', async () => {
    expect(
      await run(UNKNOWN(), async () => {
        throw new Error('the GET threw');
      }),
    ).toEqual({ got: 'stays', calls: 1 });
  });
});

describe('settle, rows 7-10: the refetched copy', () => {
  it('row 7: unmoved (fetched/purchase-1001.json): failed', async () => {
    expect((await run(UNKNOWN(), txn(UNMOVED()))).got).toEqual(settled('failed'));
  });
  it('row 7 holds whatever the lines hold: unmoved with the after values is failed', async () => {
    expect((await run(UNKNOWN(), txn({ ...MOVED_ONE(), SyncToken: '3' }))).got).toEqual(settled('failed'));
  });
  it('row 8: moved by one with the after values: the compare through the intent’s digests gives sent, sync_token_after the refetched', async () => {
    expect((await run(UNKNOWN(), txn(MOVED_ONE()))).got).toEqual(settled('sent', { sync_token_after: '4' }));
  });
  it('row 8: with an unexpected difference (answers/stored-amount.json’s body): sent-diff naming it', async () => {
    // The file's only difference from the intent's copy is line 1's Amount (101), so the compare names Line:1 (spec A1.11 says Line:2 and
    // TotalAmt, which is outcome-sent-diff.json's diff, not this body's).
    expect((await run(UNKNOWN(), txn(MOVED_ONE_AMOUNT()))).got).toEqual(settled('sent-diff', { sync_token_after: '4', diff: ['Line:1'] }));
  });
  it('row 8: a header difference is named too', async () => {
    expect((await run(UNKNOWN(), txn({ ...MOVED_ONE(), TotalAmt: 121 }))).got).toEqual(settled('sent-diff', { sync_token_after: '4', diff: ['TotalAmt'] }));
  });
  it('row 9: moved by two (refetch/purchase-1001-moved-by-two.json): sent, note edited-since', async () => {
    expect((await run(UNKNOWN(), txn(MOVED_TWO()))).got).toEqual(settled('sent', { sync_token_after: '5', note: 'edited-since' }));
  });
  it('row 9 is uncompared: moved by two with another field changed is still sent, edited-since', async () => {
    expect((await run(UNKNOWN(), txn({ ...MOVED_TWO(), TotalAmt: 121 }))).got).toEqual(settled('sent', { sync_token_after: '5', note: 'edited-since' }));
  });
  it('row 9: moved by 10^19 at 20 digits is more than one', async () => {
    const a = { ...UNKNOWN() };
    expect((await run(a, txn({ ...MOVED_TWO(), SyncToken: '10000000000000000003' }))).got).toEqual(
      settled('sent', { sync_token_after: '10000000000000000003', note: 'edited-since' }),
    );
  });
  it.each([
    ['moved by one without the after values (line 1 still 77)', { ...UNMOVED(), SyncToken: '4' }],
    ['moved by two without the after values', { ...UNMOVED(), SyncToken: '5' }],
    ['a lower SyncToken', { ...MOVED_ONE(), SyncToken: '2' }],
    ['a non-digit SyncToken', { ...MOVED_ONE(), SyncToken: '4a' }],
    ['a SyncToken a number', { ...MOVED_ONE(), SyncToken: 4 }],
    ['a SyncToken of 21 digits', { ...MOVED_ONE(), SyncToken: '1'.padEnd(21, '0') }],
    ['no SyncToken', { ...MOVED_ONE(), SyncToken: undefined }],
  ])('row 10: %s: unsettled', async (_name, t) => {
    expect((await run(UNKNOWN(), txn(t))).got).toEqual(settled('unsettled'));
  });

  describe('"holds the after values": every named line, account and class (an absent ClassRef is null)', () => {
    const withLineOne = (base: Record<string, any>, edit: (line: Record<string, any>) => void) => {
      const t = clone(base);
      edit(lineOne(t));
      return t;
    };
    it.each([
      ['another account', (l: any) => (l.AccountBasedExpenseLineDetail.AccountRef.value = '91')],
      ['another class', (l: any) => (l.AccountBasedExpenseLineDetail.ClassRef.value = '13')],
      ['no class (null, not 12)', (l: any) => delete l.AccountBasedExpenseLineDetail.ClassRef],
      ['a ClassRef with no value', (l: any) => (l.AccountBasedExpenseLineDetail.ClassRef = {})],
      ['the line gone', (l: any) => (l.Id = '9')],
    ])('moved by two, line 1 with %s: unsettled', async (_name, edit) => {
      expect((await run(UNKNOWN(), txn(withLineOne(MOVED_TWO(), edit)))).got).toEqual(settled('unsettled'));
    });
    it('moved by two with no Line array: unsettled', async () => {
      expect((await run(UNKNOWN(), txn({ ...MOVED_TWO(), Line: undefined }))).got).toEqual(settled('unsettled'));
    });
    it('a second copy of line 1 without the after values: unsettled', async () => {
      const t = MOVED_TWO();
      t.Line.push({ ...clone(lineOne(t)), AccountBasedExpenseLineDetail: { AccountRef: { value: '77' } } });
      expect((await run(UNKNOWN(), txn(t))).got).toEqual(settled('unsettled'));
    });
    it('an intent clearing the class holds on a line with no ClassRef', async () => {
      const a = UNKNOWN();
      const intent = clone(a.intent);
      intent.lines[0].after = { ...intent.lines[0].after, class_id: null, class_name: null };
      const t = withLineOne(MOVED_TWO(), (l) => delete l.AccountBasedExpenseLineDetail.ClassRef);
      expect((await run({ ...a, intent }, txn(t))).got).toEqual(settled('sent', { sync_token_after: '5', note: 'edited-since' }));
    });
  });
});

// ---- applySettled: the outcome request through the fake, and the switch.

const DIR = mkdtempSync(join(tmpdir(), 'qbo-settle-'));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));
let n = 0;
/** A switch file that exists, in this suite's temp directory. */
const switchOn = (): string => {
  const p = join(DIR, `switch-${n++}`);
  writeFileSync(p, '');
  return p;
};
const cfg = (receiptCmd: string, writeSwitch: string): WriteConfig =>
  ({ mode: 'write', receiptCmd, writeLedger: join(DIR, 'writes.jsonl'), writeSwitch, sweepStamp: join(DIR, 'stamp.json') }) as unknown as WriteConfig;
/** A switch whose turnOff is a spy that notes how many requests the fake had logged when it was called. */
const spySwitch = (fake: ReturnType<typeof receiptFake>) => {
  const seen: number[] = [];
  const sw: Switch = { isOn: async () => true, turnOff: jest.fn(async () => (seen.push(fake.log().length), true)) };
  return { sw, seen };
};
const apply = async (attempt: Lookup, s: Settled, script: FakeScript, sw?: Switch) => {
  const fake = receiptFake(script);
  const spied = spySwitch(fake);
  const recorded = await applySettled(attempt, s, { cfg: cfg(fake.cmd, '/switch-path'), kit: createKit(), sw: sw ?? spied.sw });
  return { recorded, fake, ...spied };
};
const text = (value: unknown) => JSON.stringify(value);

describe('applySettled: the outcome request, as text, the vector’s', () => {
  it('outcome-settled-failed.json: unmoved, no outcome before (m 1)', async () => {
    const a = NO_OUTCOME();
    const s = await settle(a, Object.freeze({ reread: async () => txn(UNMOVED()), wall: () => NOW }));
    const { recorded, fake } = await apply(a, s as Settled, { outcome: ['outcome-settled-failed.json'] });
    expect(text(fake.requests())).toBe(text([vector('outcome-settled-failed.json').request]));
    expect(recorded).toBe('notion');
  });
  it('outcome-settled-unknown.json: an unknown settled sent', async () => {
    const a = UNKNOWN();
    const s = await settle(a, Object.freeze({ reread: async () => txn(MOVED_ONE()), wall: () => NOW }));
    const { fake } = await apply(a, s as Settled, { outcome: ['outcome-settled-unknown.json'] });
    expect(text(fake.requests())).toBe(text([vector('outcome-settled-unknown.json').request]));
  });
  it('outcome-unsettled.json: deleted (Fault 610)', async () => {
    const a = NO_OUTCOME();
    const s = await settle(a, Object.freeze({ reread: async (): Promise<Reread> => ({ kind: 'fault', code: '610' }), wall: () => NOW }));
    const { fake } = await apply(a, s as Settled, { outcome: ['outcome-unsettled.json'] });
    expect(text(fake.requests())).toBe(text([vector('outcome-unsettled.json').request]));
  });
  it('outcome-settled-failed-2.json: an unknown settled failed (m 2), the same request', async () => {
    const a = UNKNOWN();
    const { fake } = await apply(a, settled('failed'), { outcome: ['outcome-settled-failed-2.json'] });
    expect(text(fake.requests())).toBe(text([vector('outcome-settled-failed-2.json').request]));
  });
  it('a settled sent-diff and an edited-since sent, each field in the request’s order', async () => {
    const { fake } = await apply(UNKNOWN(), settled('sent-diff', { sync_token_after: '4', diff: ['Line:1'] }), { outcome: [{ answer: { ok: true, notion: true } }] });
    expect(text(fake.requests())).toBe(
      text([{ cmd: 'outcome', key: KEY, result: 'sent-diff', sync_token_after: '4', diff: ['Line:1'], error: null, note: null }]),
    );
    const second = await apply(UNKNOWN(), settled('sent', { sync_token_after: '5', note: 'edited-since' }), { outcome: [{ answer: { ok: true, notion: true } }] });
    expect(text(second.fake.requests())).toBe(
      text([{ cmd: 'outcome', key: KEY, result: 'sent', sync_token_after: '5', diff: null, error: null, note: 'edited-since' }]),
    );
  });
});

describe('applySettled: what was recorded, read by outcomeRecorded', () => {
  it('{ ok: true, notion: false }: ledger', async () => {
    expect((await apply(UNKNOWN(), settled('failed'), { outcome: [{ answer: { ok: true, notion: false } }] })).recorded).toBe('ledger');
  });
  it('not ok (outcome-ledger-fail.json): none', async () => {
    expect((await apply(UNKNOWN(), settled('failed'), { outcome: ['outcome-ledger-fail.json'] })).recorded).toBe('none');
  });
  it('a command that exits 1: none', async () => {
    expect((await apply(UNKNOWN(), settled('failed'), { outcome: [{ misbehave: 'exit 1' }] })).recorded).toBe('none');
  });
  it('runs the command with the kit’s spawn', async () => {
    const fake = receiptFake({ outcome: ['outcome-settled-failed-2.json'] });
    const own = jest.fn(spawn) as unknown as Spawn;
    const kit = createKit({ spawn: own });
    expect(await applySettled(UNKNOWN(), settled('failed'), { cfg: cfg(fake.cmd, '/s'), kit, sw: spySwitch(fake).sw })).toBe('notion');
    expect(own).toHaveBeenCalledTimes(1);
  });
  it('a kit spawn that throws: none, and no throw', async () => {
    const fake = receiptFake({});
    const kit = createKit({
      spawn: (() => {
        throw new Error('spawn threw');
      }) as unknown as Spawn,
    });
    expect(await applySettled(UNKNOWN(), settled('failed'), { cfg: cfg(fake.cmd, '/s'), kit, sw: spySwitch(fake).sw })).toBe('none');
    expect(fake.log()).toEqual([]);
  });
});

describe('applySettled turns the switch off on a settled sent-diff, and only then (V6)', () => {
  const ok = { outcome: [{ answer: { ok: true, notion: true } }] };
  it('sent-diff: turnOff once, on the config’s switch path, before the outcome is asked', async () => {
    const { sw, seen, fake } = await apply(UNKNOWN(), settled('sent-diff', { sync_token_after: '4', diff: ['Line:1'] }), ok);
    expect(sw.turnOff).toHaveBeenCalledTimes(1);
    expect(sw.turnOff).toHaveBeenCalledWith('/switch-path');
    expect(seen).toEqual([0]);
    expect(fake.requests()).toHaveLength(1);
  });
  it('sent-diff whose outcome is refused: the switch is still turned off', async () => {
    const { sw, recorded } = await apply(UNKNOWN(), settled('sent-diff', { sync_token_after: '4', diff: ['Line:1'] }), { outcome: [{ misbehave: 'exit 1' }] });
    expect(sw.turnOff).toHaveBeenCalledTimes(1);
    expect(recorded).toBe('none');
  });
  it.each([
    settled('sent', { sync_token_after: '4' }),
    settled('sent', { sync_token_after: '5', note: 'edited-since' }),
    settled('failed'),
    settled('unsettled'),
    settled('unsettled', { note: 'deleted' }),
  ])('%o: the switch is left alone', async (s) => {
    const { sw, fake } = await apply(UNKNOWN(), s, ok);
    expect(sw.turnOff).not.toHaveBeenCalled();
    expect(fake.requests()).toHaveLength(1);
  });
});

// ---- A1.12: sequences, each lookup built from one ledger.

/** An intent line like lookup-ok.json's, on SyncToken `token`, attempt `n`, at `at`, its line 1 from `before` to `after`. */
type Ref = [string, string | null];
const intentLine = (token: string, nth: number, at: string, before: Ref = ['77', null], after: Ref = ['84', '12']) => {
  const line = clone(vector('lookup-ok.json').ledger[0]);
  const side = ([account_id, class_id]: (string | null)[]) => ({ account_id, account_name: 'Name', class_id, class_name: class_id === null ? null : 'Class' });
  return { ...line, key: `quickbooks-write:garden3d:purchase:1001:${token}:${nth}`, n: nth, at, sync_token: token, lines: [{ line_id: '1', before: side(before), after: side(after) }] };
};
const outcomeLine = (key: string, m: number, at: string, result: string, over: Record<string, unknown> = {}) => ({
  v: '1.1',
  kind: 'outcome',
  key,
  m,
  at,
  result,
  sync_token_after: null,
  diff: null,
  error: null,
  note: null,
  ...over,
});
/** The line a settled outcome appends, as the receipt command writes it from the request. */
const appended = (attempt: Lookup, s: Settled, at: string, ledger: any[]) => {
  const m = ledger.filter((l) => l.kind === 'outcome' && l.key === attempt.key).length + 1;
  return outcomeLine(attempt.key, m, at, s.result, { sync_token_after: s.sync_token_after, diff: s.diff, note: s.note });
};

/**
 * `lookup` of `key` over `ledger`, by §20's Receipt command rules: the intent, its latest outcome by m, and `superseded`: the same-SyncToken
 * attempt (smallest n) whose latest outcome is sent or sent-diff (ahead 0); else the nearest later intent naming a shared line (smallest
 * SyncToken, then n), superseding when its before for a shared line isn't this attempt's after by account and class id (ahead the SyncToken
 * difference). The vectors below check it.
 */
function lookupFrom(ledger: any[], key: string): Record<string, unknown> {
  const intents = ledger.filter((l) => l.kind === 'intent');
  const intent = intents.find((l) => l.key === key);
  const latest = (k: string) => ledger.filter((l) => l.kind === 'outcome' && l.key === k).sort((a, b) => b.m - a.m)[0] ?? null;
  const sameTxn = intents.filter((i) => i.company === intent.company && i.type === intent.type && i.id === intent.id && i.key !== key);
  const same = sameTxn
    .filter((i) => i.sync_token === intent.sync_token && ['sent', 'sent-diff'].includes(latest(i.key)?.result))
    .sort((a, b) => a.n - b.n)[0];
  if (same !== undefined) return { ok: true, intent, outcome: latest(key), superseded_by: same.key, superseded_ahead: 0 };
  const mine = new Map(intent.lines.map((l: any) => [l.line_id, l.after]));
  const later = sameTxn
    .filter((i) => BigInt(i.sync_token) > BigInt(intent.sync_token) && i.lines.some((l: any) => mine.has(l.line_id)))
    .sort((a, b) => Number(BigInt(a.sync_token) - BigInt(b.sync_token)) || a.n - b.n)[0];
  const differs =
    later !== undefined &&
    later.lines.some((l: any) => {
      const after: any = mine.get(l.line_id);
      return after !== undefined && (l.before.account_id !== after.account_id || l.before.class_id !== after.class_id);
    });
  return differs
    ? { ok: true, intent, outcome: latest(key), superseded_by: later.key, superseded_ahead: Number(BigInt(later.sync_token) - BigInt(intent.sync_token)) }
    : { ok: true, intent, outcome: latest(key), superseded_by: null, superseded_ahead: null };
}
const lookupIn = (ledger: any[], key: string): Lookup => {
  const read = lookupOk(lookupFrom(ledger, key), key, 'garden3d');
  if (read === null) throw new Error('not a valid lookup');
  return read;
};

describe('the ledger lookup used below agrees with the receipt command’s vectors', () => {
  it.each([
    'pending-superseded-same-token.json',
    'pending-superseded-later-intent.json',
    'pending-later-intent-not-superseding.json',
    'pending-same-token-failed-not-superseding.json',
    'pending-nearest-later-intent-decides.json',
    'pending-unknown.json',
  ])('%s', (name) => {
    const v = vector(name);
    for (const entry of v.answer.intents) {
      const { key: _key, ...rest } = entry;
      expect(lookupFrom(v.ledger, entry.key)).toEqual({ ok: true, ...rest });
    }
  });
  it.each(['lookup-ok.json', 'lookup-superseded.json', 'lookup-latest-wins.json'])('%s', (name) => {
    const v = vector(name);
    expect(lookupFrom(v.ledger, v.request.key)).toEqual(v.answer);
  });
});

describe('A1.12: settle sequences, through settle and applySettled with the fake', () => {
  const ATTEMPT_2 = `${KEY.slice(0, -1)}2`;
  const wallAt = (iso: string) => () => Date.parse(iso);

  it('two unknowns on one SyncToken: :1 (older) settles sent, then :2 is superseded ahead 0 and settles failed', async () => {
    const ledger: any[] = [
      intentLine('3', 1, '2026-11-18T14:00:00.000Z'),
      outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown'),
      intentLine('3', 2, '2026-11-18T14:35:00.000Z'),
      outcomeLine(ATTEMPT_2, 1, '2026-11-18T14:40:00.000Z', 'unknown'),
    ];
    const fake = receiptFake({ outcome: [{ answer: { ok: true, notion: true } }, { answer: { ok: true, notion: true } }] });
    const sw = spySwitch(fake).sw;
    const ctx = { cfg: cfg(fake.cmd, '/s'), kit: createKit(), sw };
    const reread = jest.fn(async () => txn(MOVED_ONE()));
    const first = lookupIn(ledger, KEY);
    expect(first.superseded_ahead).toBeNull();
    const s1 = (await settle(first, Object.freeze({ reread, wall: () => NOW }))) as Settled;
    expect(s1).toEqual(settled('sent', { sync_token_after: '4' }));
    expect(await applySettled(first, s1, ctx)).toBe('notion');
    ledger.push(appended(first, s1, '2026-11-18T15:00:00.000Z', ledger));

    const second = lookupIn(ledger, ATTEMPT_2);
    expect([second.superseded_by, second.superseded_ahead]).toEqual([KEY, 0]);
    const s2 = (await settle(second, Object.freeze({ reread, wall: () => NOW }))) as Settled;
    expect(s2).toEqual(settled('failed'));
    expect(await applySettled(second, s2, ctx)).toBe('notion');
    expect(reread).toHaveBeenCalledTimes(1);
    expect(text(fake.requests())).toBe(
      text([
        { cmd: 'outcome', key: KEY, result: 'sent', sync_token_after: '4', diff: null, error: null, note: null },
        { cmd: 'outcome', key: ATTEMPT_2, result: 'failed', sync_token_after: null, diff: null, error: null, note: null },
      ]),
    );
  });

  it('before :1 settles, :2 is not superseded, so it is the older that settles first', async () => {
    const ledger: any[] = [
      intentLine('3', 1, '2026-11-18T14:00:00.000Z'),
      outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown'),
      intentLine('3', 2, '2026-11-18T14:35:00.000Z'),
      outcomeLine(ATTEMPT_2, 1, '2026-11-18T14:40:00.000Z', 'unknown'),
    ];
    expect(lookupIn(ledger, ATTEMPT_2).superseded_ahead).toBeNull();
  });

  it.each([
    ['one SyncToken ahead naming another before: failed', '4', settled('failed')],
    ['two ahead: unsettled', '5', settled('unsettled')],
  ])('a later intent %s', async (_name, token, want) => {
    const ledger: any[] = [
      intentLine('3', 1, '2026-11-18T14:00:00.000Z'),
      outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown'),
      intentLine(token, 1, '2026-11-18T14:40:00.000Z', ['91', null], ['84', '12']),
    ];
    const fake = receiptFake({ outcome: [{ answer: { ok: true, notion: true } }] });
    const attempt = lookupIn(ledger, KEY);
    const reread = jest.fn(async () => txn(MOVED_ONE()));
    const s = (await settle(attempt, Object.freeze({ reread, wall: () => NOW }))) as Settled;
    expect(s).toEqual(want);
    await applySettled(attempt, s, { cfg: cfg(fake.cmd, '/s'), kit: createKit(), sw: spySwitch(fake).sw });
    expect(reread).not.toHaveBeenCalled();
    expect(text(fake.requests())).toBe(text([{ cmd: 'outcome', key: KEY, result: want.result, sync_token_after: null, diff: null, error: null, note: null }]));
  });

  it('a later intent one ahead built on this attempt’s after values supersedes nothing: the reread decides', async () => {
    const ledger: any[] = [
      intentLine('3', 1, '2026-11-18T14:00:00.000Z'),
      outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown'),
      intentLine('4', 1, '2026-11-18T14:40:00.000Z', ['84', '12'], ['77', null]),
    ];
    const attempt = lookupIn(ledger, KEY);
    expect(await settle(attempt, Object.freeze({ reread: async () => txn(MOVED_TWO()), wall: () => NOW }))).toEqual(
      settled('sent', { sync_token_after: '5', note: 'edited-since' }),
    );
  });

  it('unmoved later: waits under 10 minutes, then settles failed', async () => {
    const ledger: any[] = [intentLine('3', 1, '2026-11-18T14:52:00.000Z'), outcomeLine(KEY, 1, '2026-11-18T14:53:00.000Z', 'unknown')];
    const fake = receiptFake({ outcome: [{ answer: { ok: true, notion: true } }] });
    const reread = jest.fn(async () => txn(UNMOVED()));
    const attempt = lookupIn(ledger, KEY);
    expect(await settle(attempt, Object.freeze({ reread, wall: wallAt('2026-11-18T15:02:59.999Z') }))).toBe('wait');
    expect(reread).not.toHaveBeenCalled();
    const s = (await settle(attempt, Object.freeze({ reread, wall: wallAt('2026-11-18T15:03:00.000Z') }))) as Settled;
    expect(s).toEqual(settled('failed'));
    await applySettled(attempt, s, { cfg: cfg(fake.cmd, '/s'), kit: createKit(), sw: spySwitch(fake).sw });
    expect(text(fake.requests())).toBe(text([{ cmd: 'outcome', key: KEY, result: 'failed', sync_token_after: null, diff: null, error: null, note: null }]));
  });

  it('a later settle giving sent-diff deletes the switch file (the real switch)', async () => {
    const ledger: any[] = [intentLine('3', 1, '2026-11-18T14:00:00.000Z'), outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown')];
    const path = switchOn();
    const kit = createKit();
    const sw = createSwitch(kit.fs);
    expect(await sw.isOn(path)).toBe(true);
    const fake = receiptFake({ outcome: [{ answer: { ok: true, notion: true } }] });
    const attempt = lookupIn(ledger, KEY);
    const s = (await settle(attempt, Object.freeze({ reread: async () => txn(MOVED_ONE_AMOUNT()), wall: () => NOW }))) as Settled;
    expect(s.result).toBe('sent-diff');
    expect(await applySettled(attempt, s, { cfg: cfg(fake.cmd, path), kit, sw })).toBe('notion');
    expect(existsSync(path)).toBe(false);
    expect(await sw.isOn(path)).toBe(false);
    expect(text(fake.requests())).toBe(text([{ cmd: 'outcome', key: KEY, result: 'sent-diff', sync_token_after: '4', diff: ['Line:1'], error: null, note: null }]));
  });

  it('a later settle giving sent leaves the switch file', async () => {
    const ledger: any[] = [intentLine('3', 1, '2026-11-18T14:00:00.000Z'), outcomeLine(KEY, 1, '2026-11-18T14:30:00.000Z', 'unknown')];
    const path = switchOn();
    const kit = createKit();
    const fake = receiptFake({ outcome: [{ answer: { ok: true, notion: true } }] });
    const attempt = lookupIn(ledger, KEY);
    const s = (await settle(attempt, Object.freeze({ reread: async () => txn(MOVED_ONE()), wall: () => NOW }))) as Settled;
    await applySettled(attempt, s, { cfg: cfg(fake.cmd, path), kit, sw: createSwitch(kit.fs) });
    expect(existsSync(path)).toBe(true);
  });
});
