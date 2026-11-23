// Sanctuary Computer (quickbooks-mcp-291): the call scope: each tool call's realm and record live in its own AsyncLocalStorage context.
import { describe, it, expect, afterEach, afterAll, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { createRequire } from 'module';
import { installStubNetwork, type StubAnswer, type StubCall } from '../../fakes/stub-network.js';
import { createCallScope, createGuard, guardedAxios, installGuard } from '../../../src/http-guard.js';

const trap = trapNetwork();
const QuickBooks = createRequire(import.meta.url)('node-quickbooks');
const R2 = '9990000000000002';
const R4 = '9990000000000004';
const q = (realm: string) => `https://quickbooks.api.intuit.com/v3/company/${realm}`;
const fakeToken = () => 'qbo-fake-' + 'token';
const QR = JSON.stringify({ QueryResponse: {} });

let answer: (call: StubCall) => StubAnswer | Promise<StubAnswer> = () => ({ status: 200, body: QR });
const net = installStubNetwork((call) => answer(call));
const scope = createCallScope();
const restoreGuard = installGuard(
  createGuard({
    stacksUrl: 'https://stacks.example.test',
    keys: () => ['garden3d'],
    allowedRealm: (r) => scope.allowedRealm(r),
    callRecord: () => scope.callRecord(),
  }),
);
const ax = guardedAxios();

afterEach(() => {
  expect(trap.reached).toEqual([]);
  net.calls.length = 0;
  answer = () => ({ status: 200, body: QR });
});
afterAll(() => {
  restoreGuard();
  net.restore();
  trap.restore();
});

const refused = (p: Promise<unknown>, rule: string) => expect(p).rejects.toMatchObject({ name: 'GuardRefusedError', rule });

describe('createCallScope', () => {
  it('outside a run: no record, no realm, setRealm throws', () => {
    expect(scope.callRecord()).toBeUndefined();
    expect(scope.allowedRealm(R2)).toBe(false);
    expect(() => scope.setRealm(R2)).toThrow('qbo-guard: setRealm outside a call');
  });

  it('a run starts with a fresh record and no realm; setRealm keeps one realm', () => {
    scope.run(() => {
      expect(scope.callRecord()).toEqual({ queries: [] });
      expect(scope.allowedRealm(R2)).toBe(false);
      scope.setRealm(R2);
      expect(scope.allowedRealm(R2)).toBe(true);
      expect(scope.allowedRealm(R4)).toBe(false);
      scope.setRealm(R2);
      expect(() => scope.setRealm(R4)).toThrow("qbo-guard: the call's realm is already kept");
      expect(scope.allowedRealm(R2)).toBe(true);
    });
  });

  it('runs never share a record, nested or in sequence', () => {
    const outer = scope.run(() => {
      const mine = scope.callRecord();
      const inner = scope.run(() => scope.callRecord());
      expect(inner).not.toBe(mine);
      expect(scope.callRecord()).toBe(mine);
      return mine;
    });
    expect(scope.run(() => scope.callRecord())).not.toBe(outer);
  });

  it('two scopes are independent', () => {
    const other = createCallScope();
    scope.run(() => {
      scope.setRealm(R2);
      expect(other.callRecord()).toBeUndefined();
      expect(other.allowedRealm(R2)).toBe(false);
    });
  });
});

describe('call scope through the guard (A1.13)', () => {
  it("two overlapping calls, each a real node-quickbooks call held by a slow stub, keep their own realm and record", async () => {
    const held: Array<() => void> = [];
    let arrived = 0;
    let bothArrived: () => void = () => undefined;
    const both = new Promise<void>((r) => (bothArrived = r));
    // Only the two searches are held; anything else is answered at once.
    answer = (call) =>
      !call.path!.includes('/query?')
        ? { status: 200 }
        : new Promise<StubAnswer>((resolve) => {
            held.push(() => resolve({ status: 200, body: JSON.stringify({ QueryResponse: {} }) }));
            if (++arrived === 2) bothArrived();
          });
    const oneCall = (realm: string, other: string) =>
      scope.run(async () => {
        scope.setRealm(realm);
        const client = new QuickBooks('id', 'secret', fakeToken(), false, realm, false, false, null, '2.0', 'r');
        const done = new Promise((resolve, reject) =>
          client.findPurchases([{ field: 'limit', value: 10 }], (err: unknown, d: unknown) => (err ? reject(err) : resolve(d))),
        );
        await both; // the other call's request is in flight too
        await refused(ax.get(`${q(other)}/preferences?minorversion=75&format=json`), 'quickbooks');
        await ax.get(`${q(realm)}/preferences?minorversion=75&format=json`);
        return { done, record: scope.callRecord() };
      });
    const a = oneCall(R2, R4);
    const b = oneCall(R4, R2);
    await both;
    const [ra, rb] = await Promise.all([a, b]).then(async (rs) => {
      // answer the held searches only after both calls checked the other's realm
      while (held.length) held.shift()!();
      await Promise.all(rs.map((r) => r.done));
      return rs.map((r) => r.record);
    });
    expect(ra?.queries).toEqual([{ entity: 'purchase', url: `${q(R2)}/query?query=select%20*%20from%20purchase%20startposition%201%20maxresults%2010&minorversion=75&format=json`, status: 200 }]);
    expect(rb?.queries).toEqual([{ entity: 'purchase', url: `${q(R4)}/query?query=select%20*%20from%20purchase%20startposition%201%20maxresults%2010&minorversion=75&format=json`, status: 200 }]);
    expect(net.calls.map((c) => c.path).filter((p) => p!.includes('/query?')).sort()).toEqual(
      [R2, R4].map((r) => `/v3/company/${r}/query?query=select%20*%20from%20purchase%20startposition%201%20maxresults%2010&minorversion=75&format=json`).sort(),
    );
  });

  it('outside any run a QuickBooks request is refused and nothing is recorded', async () => {
    await refused(ax.get(`${q(R2)}/preferences?minorversion=75&format=json`), 'quickbooks');
    expect(net.calls).toHaveLength(0);
  });

  it('inside a run with no kept realm: companyinfo, preferences, a query and a report are refused; Stacks is allowed', async () => {
    await scope.run(async () => {
      for (const u of [
        `${q(R2)}/companyinfo/${R2}?minorversion=75&format=json`,
        `${q(R2)}/preferences?minorversion=75&format=json`,
        `${q(R2)}/query?query=select%20*%20from%20purchase%20maxresults%2010&minorversion=75&format=json`,
        `${q(R2)}/reports/ProfitAndLoss?start_date=2026-10-01&minorversion=75&format=json`,
      ]) {
        await refused(ax.get(u), 'quickbooks');
      }
      await ax.get('https://stacks.example.test/api/qbo/access_token?enterprise=garden3d');
      expect(scope.callRecord()).toEqual({ queries: [] });
    });
    expect(net.calls.map((c) => c.hostname)).toEqual(['stacks.example.test']);
  });

  it('bluebird keeps the call context across node-quickbooks callbacks', async () => {
    const spy = jest.fn();
    await scope.run(async () => {
      scope.setRealm(R2);
      const client = new QuickBooks('id', 'secret', fakeToken(), false, R2, false, false, null, '2.0', 'r');
      await new Promise((resolve, reject) =>
        client.findPurchases([{ field: 'limit', value: 10 }], (err: unknown, d: unknown) => {
          spy(scope.callRecord()?.queries.length);
          return err ? reject(err) : resolve(d);
        }),
      );
    });
    expect(spy).toHaveBeenCalledWith(1);
  });
});
