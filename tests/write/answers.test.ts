// Sanctuary Computer (quickbooks-mcp-294): the receipt answers' strict readers, at the reader: spec A1.4 (intentOk), A2.3 (lookupOk) and
// A1.10 (outcomeRecorded), each from the receipt-cmd/ vectors' answers and each not-quite-ok variant; and isMoved, the SyncToken compare
// (§17 Settling's "moved"). Anything not exactly ok is not ok. The results these give are T6, T7 and T8's.
import { describe, expect, it } from '@jest/globals';
import { intentOk, isMoved, lookupOk, outcomeRecorded } from '../../src/write/answers.js';
import { vector } from './receipt-fake.js';

const KEY = 'quickbooks-write:garden3d:purchase:1001:3:1';
const ATTEMPT = { company: 'garden3d', type: 'purchase', id: '1001', syncToken: '3' };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The digests with one more key, all in code-unit order, its hash a valid one. */
const addDigest = (digests: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries([...Object.entries(digests), [key, digests.Id]].sort(([a], [b]) => (a < b ? -1 : 1)));

describe('intentOk: exactly { ok: true, key, n }, the key this attempt’s with n (A1.4)', () => {
  it('intent-ok.json’s answer is ok', () => {
    expect(intentOk(vector('intent-ok.json').answer, ATTEMPT)).toStrictEqual({ ok: true, key: KEY, n: 1 });
  });
  it('n 2 with its key', () => {
    expect(intentOk({ ok: true, key: `${KEY.slice(0, -1)}2`, n: 2 }, ATTEMPT)).toStrictEqual({ ok: true, key: `${KEY.slice(0, -1)}2`, n: 2 });
  });
  it('a bill attempt', () => {
    const key = 'quickbooks-write:garden3d:bill:2001:0:1';
    expect(intentOk({ ok: true, key, n: 1 }, { company: 'garden3d', type: 'bill', id: '2001', syncToken: '0' })).toStrictEqual({ ok: true, key, n: 1 });
  });
  it('n 999999 (the pattern’s six digits) is ok', () => {
    expect(intentOk({ ok: true, key: `${KEY.slice(0, -1)}999999`, n: 999999 }, ATTEMPT).ok).toBe(true);
  });

  const ok = (): Record<string, unknown> => ({ ok: true, key: KEY, n: 1 });
  it.each([
    ['ok "true"', { ...ok(), ok: 'true' }],
    ['ok 1', { ...ok(), ok: 1 }],
    ['ok missing', { key: KEY, n: 1 }],
    ['{ ok: true } with no key', { ok: true, n: 1 }],
    ['a key for another company', { ...ok(), key: KEY.replace('garden3d', 'usb-club') }],
    ['a key for another type', { ...ok(), key: KEY.replace('purchase', 'bill') }],
    ['a key for another id', { ...ok(), key: KEY.replace(':1001:', ':1002:') }],
    ['a key for another SyncToken', { ...ok(), key: KEY.replace(':3:', ':4:') }],
    ['a key whose last part isn’t n', { ...ok(), n: 2 }],
    ['the key with :intent', { ...ok(), key: `${KEY}:intent` }],
    ['the key not a string', { ...ok(), key: 7 }],
    ['n missing', { ok: true, key: KEY }],
    ['n 1.5', { ...ok(), n: 1.5 }],
    ['n "1"', { ...ok(), n: '1' }],
    ['n 0 with key :0 (off the attempt pattern)', { ok: true, key: `${KEY.slice(0, -1)}0`, n: 0 }],
    ['n 1000000 with its key (seven digits, off the pattern)', { ok: true, key: `${KEY.slice(0, -1)}1000000`, n: 1000000 }],
    ['an extra key', { ...ok(), notion: true }],
  ])('%s: not ok, and no key', (_name, answer) => {
    expect(intentOk(answer, ATTEMPT)).toStrictEqual({ ok: false });
  });
  it.each([null, undefined, [], 'ok', 1, [ok()]])('%p: not ok', (answer) => {
    expect(intentOk(answer, ATTEMPT)).toStrictEqual({ ok: false });
  });

  it('intent-receipt-failed.json (not ok, this attempt’s key): not ok with the key', () => {
    expect(intentOk(vector('intent-receipt-failed.json').answer, ATTEMPT)).toStrictEqual({ ok: false, key: KEY });
  });
  it.each([
    ['another transaction', KEY.replace(':1001:', ':1002:')],
    ['another company', KEY.replace('garden3d', 'index-space')],
    ['another type', KEY.replace('purchase', 'bill')],
    ['another SyncToken', KEY.replace(':3:', ':2:')],
    ['n 0', `${KEY.slice(0, -1)}0`],
    ['with :intent', `${KEY}:intent`],
    ['not a string', 1],
  ])('not ok with a key for %s: no key (§3 T7)', (_name, key) => {
    expect(intentOk({ ...vector('intent-receipt-failed.json').answer, key }, ATTEMPT)).toStrictEqual({ ok: false });
  });
  it('a this-attempt key on an answer whose ok isn’t exactly false gives no key', () => {
    for (const notOk of [0, null, 'false']) expect(intentOk({ ok: notOk, reason: 'write:receipt-failed', key: KEY }, ATTEMPT)).toStrictEqual({ ok: false });
  });
  it('intent-cap-intents.json (write:cap): not ok, cap', () => {
    expect(intentOk(vector('intent-cap-intents.json').answer, ATTEMPT)).toStrictEqual({ ok: false, cap: true });
  });
  it('write:cap with an ok that isn’t exactly false is no cap', () => {
    expect(intentOk({ ok: 0, reason: 'write:cap', cause: 'cap' }, ATTEMPT)).toStrictEqual({ ok: false });
  });
  it.each([
    ['not ok without a key', { ok: false, reason: 'write:receipt-failed', cause: 'lock' }],
    ['bad-request', vector('bad-request.json').answer],
    ['the runner’s own failure', { ok: false, reason: 'failed', cause: 'command' }],
  ])('%s: not ok, no key, no cap', (_name, answer) => {
    expect(intentOk(answer, ATTEMPT)).toStrictEqual({ ok: false });
  });
});

describe('lookupOk: exactly { ok: true, intent, outcome, superseded_by, superseded_ahead }, each part strictly (A2.3)', () => {
  const answer = (): Record<string, any> => clone(vector('lookup-ok.json').answer);
  const check = (a: unknown, key = KEY, company = 'garden3d') => lookupOk(a, key, company);

  it('lookup-ok.json: the entry, with the asked key', () => {
    const a = answer();
    expect(check(a)).toStrictEqual({ key: KEY, intent: a.intent, outcome: a.outcome, superseded_by: null, superseded_ahead: null });
  });
  it('lookup-superseded.json: superseded two ahead', () => {
    const a = clone(vector('lookup-superseded.json').answer);
    expect(check(a)).toStrictEqual({
      key: KEY,
      intent: a.intent,
      outcome: a.outcome,
      superseded_by: 'quickbooks-write:garden3d:purchase:1001:5:1',
      superseded_ahead: 2,
    });
  });
  it('an intent with no outcome', () => {
    expect(check({ ...answer(), outcome: null })?.outcome).toBeNull();
  });
  it('superseded_ahead 0 with its superseder', () => {
    expect(check({ ...answer(), superseded_by: `${KEY.slice(0, -1)}2`, superseded_ahead: 0 })?.superseded_ahead).toBe(0);
  });
  it('each outcome result, a send’s failed error, and a settle’s notes are valid outcome lines', () => {
    const outcome = answer().outcome;
    const lines = [
      { result: 'failed', error: { code: '6000', intuit_tid: 'fake-tid-0002' } },
      { result: 'failed', error: { code: '6210', intuit_tid: null } },
      { result: 'sent-diff', diff: ['Line:2', 'TotalAmt'] },
      { result: 'unknown', sync_token_after: null, note: 'id-mismatch' },
      { result: 'sent', note: 'edited-since', m: 2 },
      { result: 'unsettled', sync_token_after: null, note: 'deleted', m: 3 },
      { result: 'stale', sync_token_after: null },
      { result: 'refused', sync_token_after: null },
    ];
    for (const over of lines) expect(check({ ...answer(), outcome: { ...outcome, ...over } })).not.toBeNull();
  });

  it.each([
    ['ok "true"', { ok: 'true' }],
    ['ok 1', { ok: 1 }],
    ['ok false', { ok: false }],
    ['an extra key', { cause: 'x' }],
    ['superseded_by not an attempt key', { superseded_by: 'x', superseded_ahead: 1 }],
    ['superseded_by a number', { superseded_by: 5, superseded_ahead: 1 }],
    ['superseded_by an intent row key', { superseded_by: `${KEY}:intent`, superseded_ahead: 1 }],
    ['superseded_ahead -1', { superseded_by: KEY, superseded_ahead: -1 }],
    ['superseded_ahead 1.5', { superseded_by: KEY, superseded_ahead: 1.5 }],
    ['superseded_ahead "2"', { superseded_by: KEY, superseded_ahead: '2' }],
    ['superseded_by set, superseded_ahead null', { superseded_by: KEY, superseded_ahead: null }],
    ['superseded_by null, superseded_ahead set', { superseded_by: null, superseded_ahead: 0 }],
    ['intent null', { intent: null }],
    ['outcome a string', { outcome: 'sent' }],
  ])('%s: null', (_name, over) => {
    expect(check({ ...answer(), ...over })).toBeNull();
  });
  it.each(['ok', 'intent', 'outcome', 'superseded_by', 'superseded_ahead'])('%s missing: null', (k) => {
    const a = answer();
    delete a[k];
    expect(check(a)).toBeNull();
  });
  it.each([null, undefined, [], 'ok', vector('lookup-not-found.json').answer, vector('lookup-lock-busy.json').answer])('%p: null', (a) => {
    expect(check(a)).toBeNull();
  });
  it('the asked key off the attempt pattern, or for another company than the call’s: null', () => {
    expect(check(answer(), `${KEY}:intent`)).toBeNull();
    expect(check(answer(), KEY, 'usb-club')).toBeNull();
  });

  // TG5: each part of the attempt pattern, with the intent and outcome carrying the same key, so only the pattern decides.
  describe('the attempt pattern on the asked key, the intent and outcome rekeyed to match', () => {
    const rekeyed = (key: string) => {
      const a = answer();
      const [, company, type, id, sync_token, n] = key.split(':');
      Object.assign(a.intent, { key, company, type, id, sync_token, n: Number(n) });
      a.outcome.key = key;
      return check(a, key, company);
    };
    it('another valid key, rekeyed, is read (the control)', () => {
      expect(rekeyed('quickbooks-write:usb-club:bill:12345678901234567890:12345678901234567890:999999')).not.toBeNull();
    });
    it.each([
      ['an :intent suffix', `${KEY}:intent`],
      ['a type invoice', KEY.replace(':purchase:', ':invoice:')],
      ['a company off the four', KEY.replace(':garden3d:', ':other-co:')],
      ['an id of 21 digits', KEY.replace(':1001:', `:${'1'.repeat(21)}:`)],
      ['an empty id', KEY.replace(':1001:', '::')],
      ['a SyncToken of 21 digits', KEY.replace(':3:', `:${'3'.repeat(21)}:`)],
      ['an n of 0', `${KEY.slice(0, -1)}0`],
      ['an n of seven digits', `${KEY.slice(0, -1)}1000000`],
      ['an n led by 0', `${KEY.slice(0, -1)}01`],
    ])('%s: null', (_name, key) => {
      expect(rekeyed(key)).toBeNull();
    });
  });
  it.each([
    ['another company', 'quickbooks-write:other-co:purchase:1001:5:1'],
    ['a type invoice', 'quickbooks-write:garden3d:invoice:1001:5:1'],
  ])('superseded_by with %s: null', (_name, by) => {
    expect(check({ ...answer(), superseded_by: by, superseded_ahead: 2 })).toBeNull();
  });

  describe('the intent: a valid intent line of the asked key', () => {
    const withIntent = (edit: (intent: Record<string, any>) => void) => {
      const a = answer();
      edit(a.intent);
      return check(a);
    };
    it.each([
      ['its key another attempt’s', (i: any) => (i.key = `${KEY.slice(0, -1)}2`)],
      ['company not the key’s', (i: any) => (i.company = 'usb-club')],
      ['type not the key’s', (i: any) => (i.type = 'bill')],
      ['id not the key’s', (i: any) => (i.id = '1002')],
      ['sync_token not the key’s', (i: any) => (i.sync_token = '4')],
      ['n not the key’s', (i: any) => (i.n = 2)],
      ['an extra field', (i: any) => (i.extra = 1)],
      ['v 1.0', (i: any) => (i.v = '1.0')],
      ['kind outcome', (i: any) => (i.kind = 'outcome')],
      ['an at that isn’t a time', (i: any) => (i.at = 'yesterday')],
      ['an at failing only the round trip (no millis)', (i: any) => (i.at = '2026-11-18T14:00:00Z')],
      ['an at in another zone', (i: any) => (i.at = '2026-11-18T09:00:00.000-05:00')],
      ['an at a number (epoch ms)', (i: any) => (i.at = Date.parse(i.at))],
      ['n a string', (i: any) => (i.n = '1')],
      ['reason not a string', (i: any) => (i.reason = 1)],
      ['undo_of not an attempt key', (i: any) => (i.undo_of = 'x')],
      ['lines not an array', (i: any) => (i.lines = {})],
      ['no lines', (i: any) => (i.lines = [])],
      ['a line with an extra key', (i: any) => (i.lines[0].extra = 1)],
      ['a line_id off the id pattern', (i: any) => (i.lines[0].line_id = 'x')],
      ['a side with an extra key', (i: any) => (i.lines[0].after.extra = 1)],
      ['a side missing account_name', (i: any) => delete i.lines[0].before.account_name],
      ['an account_id off the id pattern', (i: any) => (i.lines[0].after.account_id = '8x')],
      ['a class_id off the id pattern', (i: any) => (i.lines[0].after.class_id = 'c')],
      ['a class_name a number', (i: any) => (i.lines[0].after.class_name = 1)],
      ['a side not an object', (i: any) => (i.lines[0].before = null)],
      ['digests unsorted', (i: any) => (i.digests = Object.fromEntries(Object.entries(i.digests).reverse()))],
      ['a digest not hex', (i: any) => (i.digests.Id = 'z'.repeat(64))],
      ['a digest in upper case', (i: any) => (i.digests.Id = i.digests.Id.toUpperCase())],
      ['digests without Line', (i: any) => delete i.digests.Line],
      ['digests without a named line’s Line:<id>', (i: any) => delete i.digests['Line:1']],
      ['digests holding SyncToken', (i: any) => (i.digests = Object.fromEntries([...Object.entries(i.digests), ['SyncToken', i.digests.Id]].sort()))],
      ['digests not an object', (i: any) => (i.digests = [])],
      ['digests holding MetaData', (i: any) => (i.digests = addDigest(i.digests, 'MetaData'))],
      ['digests holding sparse', (i: any) => (i.digests = addDigest(i.digests, 'sparse'))],
      ['digests holding a bare Line:', (i: any) => (i.digests = addDigest(i.digests, 'Line:'))],
      ['a digest that is a list holding a hex string', (i: any) => (i.digests.Id = [i.digests.Id])],
      ['a line_id a number', (i: any) => (i.lines[0].line_id = 1)],
      ['an account_id a number', (i: any) => (i.lines[0].after.account_id = 84)],
      ['a class_id a number', (i: any) => (i.lines[0].after.class_id = 12)],
      ['an account_name a number', (i: any) => (i.lines[0].after.account_name = 1)],
      ['a line_id off the id pattern with its own Line:<id> digest', (i: any) => {
        i.lines[0].line_id = 'x';
        i.digests = addDigest(i.digests, 'Line:x');
      }],
      ['a line_id of 21 digits with its own Line:<id> digest', (i: any) => {
        i.lines[0].line_id = '1'.repeat(21);
        i.digests = addDigest(i.digests, `Line:${'1'.repeat(21)}`);
      }],
      ['an empty account_id', (i: any) => (i.lines[0].after.account_id = '')],
      ['an account_id of 21 digits', (i: any) => (i.lines[0].after.account_id = '8'.repeat(21))],
      ['an empty class_id', (i: any) => (i.lines[0].after.class_id = '')],
      ['a digest of 63 hex characters', (i: any) => (i.digests.Id = i.digests.Id.slice(1))],
      ['a digest of 65 hex characters', (i: any) => (i.digests.Id = `0${i.digests.Id}`)],
      ['undo_of for a company off the four', (i: any) => (i.undo_of = 'quickbooks-write:other-co:purchase:1001:3:9')],
      ['undo_of with a type invoice', (i: any) => (i.undo_of = 'quickbooks-write:garden3d:invoice:1001:3:9')],
    ])('%s: null', (_name, edit) => {
      expect(withIntent(edit)).toBeNull();
    });
    it('ids of 20 digits are ids (the pattern’s top)', () => {
      expect(withIntent((i) => Object.assign(i.lines[0].after, { account_id: '8'.repeat(20), class_id: '1'.repeat(20) }))).not.toBeNull();
    });
    it.each(['v', 'kind', 'key', 'n', 'at', 'company', 'type', 'id', 'sync_token', 'lines', 'digests', 'reason', 'undo_of'])('%s missing: null', (k) => {
      expect(withIntent((i) => delete i[k])).toBeNull();
    });
    it('an undo’s intent (undo_of an attempt key) is valid', () => {
      expect(withIntent((i) => (i.undo_of = `${KEY.slice(0, -1)}9`))).not.toBeNull();
    });
  });

  describe('the outcome: null, or a valid outcome line of the asked key', () => {
    const withOutcome = (edit: (outcome: Record<string, any>) => void) => {
      const a = answer();
      edit(a.outcome);
      return check(a);
    };
    it.each([
      ['another key', (o: any) => (o.key = `${KEY.slice(0, -1)}2`)],
      ['an extra field', (o: any) => (o.extra = 1)],
      ['v 1.0', (o: any) => (o.v = '1.0')],
      ['kind intent', (o: any) => (o.kind = 'intent')],
      ['m 0', (o: any) => (o.m = 0)],
      ['m 1.5', (o: any) => (o.m = 1.5)],
      ['a bad at', (o: any) => (o.at = '2026-11-18T14:01:00Z')],
      ['an at a number (epoch ms)', (o: any) => (o.at = Date.parse(o.at))],
      ['an unknown result', (o: any) => (o.result = 'done')],
      ['sync_token_after off the id pattern', (o: any) => (o.sync_token_after = '4a')],
      ['sync_token_after a number', (o: any) => (o.sync_token_after = 4)],
      ['a diff on a sent', (o: any) => (o.diff = ['TotalAmt'])],
      ['a sent-diff with no diff', (o: any) => (o.result = 'sent-diff')],
      ['a sent-diff with an empty diff', (o: any) => Object.assign(o, { result: 'sent-diff', diff: [] })],
      ['a sent-diff with an unsorted diff', (o: any) => Object.assign(o, { result: 'sent-diff', diff: ['TotalAmt', 'Line:2'] })],
      ['a sent-diff with a name off the pattern', (o: any) => Object.assign(o, { result: 'sent-diff', diff: ['a b'] })],
      ['a sent-diff with a name not a string', (o: any) => Object.assign(o, { result: 'sent-diff', diff: [1] })],
      ['an error on a sent', (o: any) => (o.error = { code: '6000', intuit_tid: null })],
      ['an error with an off-pattern code', (o: any) => Object.assign(o, { result: 'failed', error: { code: 'x y', intuit_tid: null } })],
      ['an error with a code not a string', (o: any) => Object.assign(o, { result: 'failed', error: { code: 6000, intuit_tid: null } })],
      ['an error with an off-pattern tid', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000', intuit_tid: 'a_b' } })],
      ['an error with a tid a number', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000', intuit_tid: 1 } })],
      ['an error with no tid key', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000' } })],
      ['an error with an extra key', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000', intuit_tid: null, x: 1 } })],
      ['an error not an object', (o: any) => Object.assign(o, { result: 'failed', error: '6000' })],
      ['an unknown note', (o: any) => (o.note = 'other')],
      ['id-mismatch past m 1', (o: any) => Object.assign(o, { result: 'unknown', note: 'id-mismatch', m: 2 })],
      ['a result that is a list', (o: any) => (o.result = ['sent'])],
      ['a note that is a list', (o: any) => (o.note = ['deleted'])],
      ['a result with trailing text', (o: any) => (o.result = 'sentx')],
      ['a result with leading text', (o: any) => (o.result = 'xsent')],
      ['a note with trailing text', (o: any) => (o.note = 'deletedx')],
      ['a note with leading text', (o: any) => (o.note = 'xdeleted')],
      ['an empty sync_token_after', (o: any) => (o.sync_token_after = '')],
      ['a sync_token_after of 21 digits', (o: any) => (o.sync_token_after = '4'.repeat(21))],
      ['a diff name of 65 characters', (o: any) => Object.assign(o, { result: 'sent-diff', diff: ['A'.repeat(65)] })],
      ['an error code of 65 characters', (o: any) => Object.assign(o, { result: 'failed', error: { code: 'A'.repeat(65), intuit_tid: null } })],
      ['an error tid of 65 characters', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000', intuit_tid: 'a'.repeat(65) } })],
    ])('%s: null', (_name, edit) => {
      expect(withOutcome(edit)).toBeNull();
    });
    it.each([
      ['a sync_token_after of 20 digits', (o: any) => (o.sync_token_after = '4'.repeat(20))],
      ['a diff name of 64 characters, every pattern character', (o: any) => Object.assign(o, { result: 'sent-diff', diff: ['Aa0_:.-'.padEnd(64, 'z')] })],
      ['an error code with an underscore and 64 characters', (o: any) => Object.assign(o, { result: 'failed', error: { code: 'A_b-9'.padEnd(64, 'x'), intuit_tid: null } })],
      ['an error tid of 64 characters', (o: any) => Object.assign(o, { result: 'failed', error: { code: '6000', intuit_tid: 'a-Z9'.padEnd(64, '0') } })],
    ])('%s: read', (_name, edit) => {
      expect(withOutcome(edit)).not.toBeNull();
    });
    it.each(['v', 'kind', 'key', 'm', 'at', 'result', 'sync_token_after', 'diff', 'error', 'note'])('%s missing: null', (k) => {
      expect(withOutcome((o) => delete o[k])).toBeNull();
    });
    it('a sent-diff naming one field twice is in order, as the receipt command sorts and compares', () => {
      expect(withOutcome((o) => Object.assign(o, { result: 'sent-diff', diff: ['TotalAmt', 'TotalAmt'] }))).not.toBeNull();
    });
  });
});

describe('outcomeRecorded: notion only for exactly { ok: true, notion: true } (A1.10)', () => {
  it('outcome-sent.json’s answer: notion', () => {
    expect(outcomeRecorded(vector('outcome-sent.json').answer)).toBe('notion');
  });
  it('{ ok: true, notion: false }: ledger', () => {
    expect(outcomeRecorded({ ok: true, notion: false })).toBe('ledger');
  });
  it.each([
    ['not ok', vector('outcome-ledger-fail.json').answer],
    ['the runner’s own failure', { ok: false, reason: 'failed', cause: 'command' }],
    ['{ ok: true } with no notion', { ok: true }],
    ['notion "true"', { ok: true, notion: 'true' }],
    ['notion 1', { ok: true, notion: 1 }],
    ['notion null', { ok: true, notion: null }],
    ['ok "true"', { ok: 'true', notion: true }],
    ['ok 1', { ok: 1, notion: false }],
    ['an extra key', { ok: true, notion: true, cause: 'x' }],
    ['null', null],
    ['an array', [{ ok: true, notion: true }]],
  ])('%s: none', (_name, answer) => {
    expect(outcomeRecorded(answer)).toBe('none');
  });
});

describe('isMoved: both SyncTokens digits, the got one greater as an integer', () => {
  it.each([
    ['3', '4'],
    ['3', '5'],
    ['9', '10'], // a string compare says "10" < "9"
    ['99999999999999999998', '99999999999999999999'], // a Number compare can't tell 20 digits apart
    ['0', '00000000000000000001'],
  ])('%s → %s moved', (sent, got) => {
    expect(isMoved(sent, got)).toBe(true);
  });
  it.each([
    ['3', '3', 'equal'],
    ['3', '03', 'equal as integers'],
    ['4', '3', 'lower'],
    ['10', '9', 'lower as integers'],
    ['99999999999999999999', '99999999999999999998', 'lower by one at 20 digits'],
    ['3', '4a', 'a non-digit'],
    ['3', ' 4', 'a space (BigInt would read it)'],
    ['3', '+4', 'a sign'],
    ['3', '0x10', 'hex (BigInt would read it)'],
    ['3', '', 'empty'],
    ['3', '9'.repeat(21), '21 digits'],
    ['x', '4', 'a non-digit sent'],
    ['', '4', 'an empty sent (BigInt would read it as 0)'],
    ['000000000000000000003', '4', 'a sent of 21 digits led by zeros'],
    ['9'.repeat(21), '9'.repeat(22), '21 digits sent'],
  ])('%s → %s not moved (%s)', (sent, got) => {
    expect(isMoved(sent, got)).toBe(false);
  });
  it.each([4, 4n, null, undefined, ['4']])('a got of %p is not moved', (got) => {
    expect(isMoved('3', got)).toBe(false);
  });
});
