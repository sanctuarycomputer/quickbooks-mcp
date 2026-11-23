// Sanctuary Computer (quickbooks-mcp-286): the per-call store (A3.3 no module-level current company, A3.4 overlapping calls, A3.5 the realm rule).
import { describe, it, expect } from '@jest/globals';
import {
  clearFailure,
  currentCall,
  currentRealmAllows,
  currentRecord,
  recordFailure,
  runInCall,
  setCallToken,
  setUsedOffset,
} from '../../../src/clients/call-context.js';
import { bindPromiseContext, quickbooksBluebird } from '../../../src/clients/bluebird-context.js';

// node-quickbooks' own promise library (its dependency, never this package's), bound as the entry binds it at start (T10).
const Bluebird = quickbooksBluebird() as any;
bindPromiseContext();

const REALM_A = '9990000000000002';
const REALM_B = '9990000000000004';
const TOKEN = (n: number) => ['qbo', 'test', String(n)].join('-'); // built at runtime: no token-shaped literal

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A promise and its resolve, to hold one call until the other has run. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

describe('outside a call', () => {
  it('there is no store, no record, and no realm is allowed', () => {
    expect(currentCall()).toBeUndefined();
    expect(currentRecord()).toBeUndefined();
    expect(currentRealmAllows(REALM_A)).toBe(false);
  });

  it('recordFailure, clearFailure and setUsedOffset are no-ops', () => {
    expect(() => recordFailure({ reason: 'fork-error' })).not.toThrow();
    expect(() => clearFailure()).not.toThrow();
    expect(() => setUsedOffset(3)).not.toThrow();
    expect(currentCall()).toBeUndefined();
  });

  it('setCallToken throws (it is only called inside a call)', () => {
    expect(() => setCallToken(TOKEN(1), REALM_A)).toThrow('call-context: setCallToken outside a call');
  });
});

describe('inside a call', () => {
  it('the store starts with the company, a fresh record, no failure, no realm, token or offset, and no warnings', async () => {
    const store = await runInCall('garden3d', async () => currentCall());
    expect(store).toEqual({ company: 'garden3d', record: { queries: [] }, failure: null, warnings: [] });
    expect(store!.realm).toBeUndefined();
    expect(store!.token).toBeUndefined();
    expect(store!.usedOffset).toBeUndefined();
  });

  it('runInCall returns what fn resolves and passes on what it rejects', async () => {
    await expect(runInCall('garden3d', async () => 7)).resolves.toBe(7);
    await expect(runInCall('garden3d', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(currentCall()).toBeUndefined();
  });

  it('currentRecord is the store record, and each call gets its own', async () => {
    const [a, b] = await Promise.all([
      runInCall('garden3d', async () => {
        expect(currentRecord()).toBe(currentCall()!.record);
        return currentRecord();
      }),
      runInCall('garden3d', async () => currentRecord()),
    ]);
    expect(a).toEqual({ queries: [] });
    expect(b).toEqual({ queries: [] });
    expect(a).not.toBe(b);
  });

  it('currentRealmAllows is false before setCallToken, then true only for the set realm', async () => {
    await runInCall('garden3d', async () => {
      expect(currentRealmAllows(REALM_A)).toBe(false);
      expect(currentRealmAllows('')).toBe(false);
      setCallToken(TOKEN(1), REALM_A);
      expect(currentCall()).toMatchObject({ token: TOKEN(1), realm: REALM_A });
      expect(currentRealmAllows(REALM_A)).toBe(true);
      expect(currentRealmAllows(REALM_B)).toBe(false);
      expect(currentRealmAllows('')).toBe(false);
    });
  });

  it('an empty realm is never allowed, even when it is the one set (A3.5)', async () => {
    await runInCall('garden3d', async () => {
      setCallToken(TOKEN(1), '');
      expect(currentRealmAllows('')).toBe(false);
      expect(currentRealmAllows(REALM_A)).toBe(false);
    });
  });

  it('recordFailure sets the failure, clearFailure clears it, setUsedOffset sets the offset', async () => {
    await runInCall('garden3d', async () => {
      const f = { reason: 'stacks-unreachable', source: 'stacks' as const };
      recordFailure(f);
      expect(currentCall()!.failure).toBe(f);
      clearFailure();
      expect(currentCall()!.failure).toBeNull();
      setUsedOffset(25);
      expect(currentCall()!.usedOffset).toBe(25);
    });
  });
});

describe('overlapping calls (A3.4): each sees only its own store', () => {
  it('across await, setImmediate and a bluebird .then', async () => {
    const holdA = gate();
    const holdB = gate();
    const seen: string[] = [];
    const see = (where: string) => seen.push(`${where}:${currentCall()?.company}:${currentCall()?.realm}`);

    const a = runInCall('garden3d', async () => {
      setCallToken(TOKEN(1), REALM_A);
      holdB.open();
      await holdA.wait; // B runs and sets its own token meanwhile
      see('A-await');
      await new Promise<void>((resolve) => setImmediate(() => (see('A-immediate'), resolve())));
      await Bluebird.resolve().then(() => see('A-bluebird'));
      expect(currentRealmAllows(REALM_A)).toBe(true);
      expect(currentRealmAllows(REALM_B)).toBe(false);
      return currentCall()!.token;
    });
    const b = runInCall('usb-club', async () => {
      await holdB.wait;
      setCallToken(TOKEN(2), REALM_B);
      holdA.open();
      await tick();
      see('B-await');
      await new Promise<void>((resolve) => setImmediate(() => (see('B-immediate'), resolve())));
      await Bluebird.resolve().then(() => see('B-bluebird'));
      expect(currentRealmAllows(REALM_B)).toBe(true);
      expect(currentRealmAllows(REALM_A)).toBe(false);
      return currentCall()!.token;
    });

    await expect(Promise.all([a, b])).resolves.toEqual([TOKEN(1), TOKEN(2)]);
    expect(seen.filter((s) => s.startsWith('A')).sort()).toEqual(
      ['A-await', 'A-bluebird', 'A-immediate'].map((w) => `${w}:garden3d:${REALM_A}`),
    );
    expect(seen.filter((s) => s.startsWith('B')).sort()).toEqual(
      ['B-await', 'B-bluebird', 'B-immediate'].map((w) => `${w}:usb-club:${REALM_B}`),
    );
  });

  it("bluebird .then callbacks queued by both calls in one tick each run in their own call", async () => {
    const both = gate();
    let started = 0;
    const one = (company: string) =>
      runInCall(company, async () => {
        started += 1;
        if (started === 2) both.open();
        await both.wait; // both resume in the same tick, so their .then callbacks share one bluebird drain
        return Bluebird.resolve().then(() => currentCall()?.company);
      });
    await expect(Promise.all([one('garden3d'), one('usb-club')])).resolves.toEqual(['garden3d', 'usb-club']);
  });

  it("a failure or offset set in one call does not reach the other", async () => {
    const hold = gate();
    const a = runInCall('garden3d', async () => {
      recordFailure({ reason: 'fork-error' });
      setUsedOffset(10);
      hold.open();
      return currentCall();
    });
    const b = runInCall('usb-club', async () => {
      await hold.wait;
      return currentCall();
    });
    const [sa, sb] = await Promise.all([a, b]);
    expect(sa).toMatchObject({ failure: { reason: 'fork-error' }, usedOffset: 10 });
    expect(sb).toMatchObject({ company: 'usb-club', failure: null });
    expect(sb!.usedOffset).toBeUndefined();
  });
});
