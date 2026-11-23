// Sanctuary Computer (quickbooks-mcp-291): the backstop: no socket opens unless the guard issued a ticket for exactly that request.
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import { AsyncLocalStorage } from 'async_hooks';
import { spawnSync } from 'child_process';
import http from 'http';
import http2 from 'http2';
import https from 'https';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { installStubNetwork, type StubAnswer, type StubCall } from '../../fakes/stub-network.js';
import { assertFreshBuild, ROOT } from '../../e2e/helpers.js';
import {
  BACKSTOP_MARK,
  createCallScope,
  createGuard,
  guardedAxios,
  GuardRefusedError,
  installBackstop,
  installGuard,
  runIssued,
} from '../../../src/http-guard.js';

const trap = trapNetwork();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const QuickBooks = createRequire(import.meta.url)('node-quickbooks');
const REALM = '9990000000000002';
const Q = `https://quickbooks.api.intuit.com/v3/company/${REALM}`;
const P = `${Q}/preferences?minorversion=75&format=json`;
const PATH = `/v3/company/${REALM}/preferences?minorversion=75&format=json`;
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
const restoreBackstop = installBackstop();
const ax = guardedAxios();

let stderr: string[] = [];
beforeEach(() => {
  stderr = [];
  jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as any);
});
afterEach(() => {
  expect(trap.reached).toEqual([]);
  net.calls.length = 0;
  answer = () => ({ status: 200, body: QR });
});
afterAll(() => {
  restoreBackstop();
  restoreGuard();
  net.restore();
  trap.restore();
});

const TICKET = { method: 'GET', hostname: 'quickbooks.api.intuit.com', port: '', path: PATH };
const OPTIONS = { method: 'GET', hostname: 'quickbooks.api.intuit.com', port: '', path: PATH };
const refusedBackstop = (fn: () => unknown) => {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GuardRefusedError);
  expect((err as GuardRefusedError).rule).toBe('backstop');
};
const inCall = <T>(fn: () => Promise<T>): Promise<T> =>
  scope.run(async () => {
    scope.setRealm(REALM);
    return fn();
  });

describe('the backstop in place (A1.8)', () => {
  it('every replaced function carries the marker', () => {
    const g = globalThis as Record<string, any>;
    for (const fn of [https.request, https.get, http.request, http.get, http2.connect, g.fetch, g.WebSocket]) {
      expect((fn as any)[BACKSTOP_MARK]).toBe(true);
    }
    expect(BACKSTOP_MARK).toBe(Symbol.for('qbo-guard.backstop'));
  });

  it('refuses, with nothing at the stub: a raw POST to /upload, https.get, http.request/get, fetch, WebSocket, http2.connect', () => {
    refusedBackstop(() => https.request(`${Q}/upload`, { method: 'POST' }));
    refusedBackstop(() => https.get(P));
    refusedBackstop(() => http.request('http://quickbooks.api.intuit.com/'));
    refusedBackstop(() => http.get('http://quickbooks.api.intuit.com/'));
    refusedBackstop(() => runIssued(TICKET, () => http.request({ ...OPTIONS })));
    refusedBackstop(() => runIssued(TICKET, () => http.get({ ...OPTIONS })));
    refusedBackstop(() => (globalThis as any).fetch('https://quickbooks.api.intuit.com/'));
    refusedBackstop(() => new (globalThis as any).WebSocket('wss://x.example.test/'));
    refusedBackstop(() => http2.connect('https://quickbooks.api.intuit.com'));
    expect(net.calls).toHaveLength(0);
    expect(stderr[0]).toBe(`qbo-guard: refused POST https://quickbooks.api.intuit.com/v3/company/${REALM}/upload (backstop)\n`);
    expect(stderr).toHaveLength(9);
  });

  it('inside a ticket: the matching request goes once; a second under the same ticket is refused', () => {
    runIssued(TICKET, () => {
      https.request({ ...OPTIONS }).end();
      refusedBackstop(() => https.request({ ...OPTIONS }));
    });
    expect(net.calls).toHaveLength(1);
  });

  it.each([
    ['only its method', { method: 'POST' }],
    ['only its hostname', { hostname: 'quickbooks.api.intuit.com.evil.test' }],
    ['only its port', { port: '8443' }],
    ['only its path-with-query', { path: `${PATH}&x=1` }],
  ])('a call differing from the ticket in %s is refused', (_what, change) => {
    runIssued(TICKET, () => refusedBackstop(() => https.request({ ...OPTIONS, ...change })));
    expect(net.calls).toHaveLength(0);
  });

  it('the call is read as Node reads it: a URL string, a URL object, a URL with options over it, host for hostname', () => {
    runIssued(TICKET, () => https.request(P).end());
    runIssued(TICKET, () => https.request(new URL(P)).end());
    runIssued(TICKET, () => https.request(`https://quickbooks.api.intuit.com/v3/company/${REALM}/x`, { path: PATH }).end());
    runIssued(TICKET, () => https.request({ host: 'quickbooks.api.intuit.com', path: PATH, method: 'get' }).end());
    runIssued(TICKET, () => https.get(P));
    runIssued({ ...TICKET, path: '/' }, () => https.request({ hostname: 'quickbooks.api.intuit.com' }).end());
    expect(net.calls).toHaveLength(6);
    runIssued(TICKET, () => refusedBackstop(() => https.request({ ...OPTIONS, port: 443 })));
    runIssued(TICKET, () => refusedBackstop(() => https.request(P, { method: 'POST' })));
    runIssued(TICKET, () => refusedBackstop(() => https.request(undefined as any)));
    expect(net.calls).toHaveLength(6);
  });

  it('a ticket store that throws on read refuses', () => {
    // Only the ticket store faults (its stores carry `used`); every other AsyncLocalStorage reads as usual.
    const real = AsyncLocalStorage.prototype.getStore;
    jest.spyOn(AsyncLocalStorage.prototype, 'getStore').mockImplementation(function (this: AsyncLocalStorage<unknown>) {
      const s = real.call(this);
      if (s !== null && typeof s === 'object' && 'used' in s) throw new Error('store fault');
      return s;
    });
    runIssued(TICKET, () => refusedBackstop(() => https.request({ ...OPTIONS })));
    expect(net.calls).toHaveLength(0);
  });

  it('a call it cannot describe is still refused and logged as OTHER <unparsable url>', () => {
    refusedBackstop(() => (globalThis as any).fetch('not a url'));
    refusedBackstop(() =>
      http.request(
        Object.defineProperty({}, 'hostname', {
          enumerable: true,
          get() {
            throw new Error('boom');
          },
        }),
      ),
    );
    expect(stderr).toEqual(['qbo-guard: refused OTHER <unparsable url> (backstop)\n', 'qbo-guard: refused OTHER <unparsable url> (backstop)\n']);
  });

  it('installing again changes nothing, and its restore does nothing', () => {
    const before = [https.request, https.get, http.request, http.get, http2.connect];
    const again = installBackstop();
    expect([https.request, https.get, http.request, http.get, http2.connect]).toEqual(before);
    again();
    expect([https.request, https.get, http.request, http.get, http2.connect]).toEqual(before);
  });
});

describe('the guard under the backstop', () => {
  it('an allowed request through the guarded instance passes its ticket', async () => {
    await inCall(() => ax.get(P));
    expect(net.calls.map((c) => c.path)).toEqual([PATH]);
  });

  it('a node-quickbooks call passes', async () => {
    const client = new QuickBooks('id', 'secret', 'qbo-fake-' + 'token', false, REALM, false, false, null, '2.0', 'r');
    await inCall(() => new Promise((resolve, reject) => client.getPreferences((err: unknown, d: unknown) => (err ? reject(err) : resolve(d)))));
    expect(net.calls.map((c) => c.path)).toEqual([PATH]);
  });

  it.each([[P], ['https://stacks.example.test/api/qbo/access_token?enterprise=garden3d']])('a 302 from %s is not followed (A1.6 with the backstop)', async (url) => {
    answer = () => ({ status: 302, headers: { Location: P } });
    await expect(inCall(() => ax.get(url))).rejects.toMatchObject({ response: { status: 302 } });
    expect(net.calls).toHaveLength(1);
  });
});

describe('installBackstop on given modules (A1.10(d), its backstop arm)', () => {
  const KEYS: Array<[string, string]> = [
    ['global', 'fetch'],
    ['global', 'WebSocket'],
    ['http', 'request'],
    ['http', 'get'],
    ['http2', 'connect'],
    ['https', 'get'],
    ['https', 'request'],
  ];
  const fakes = () => {
    const f: Record<string, Record<string, unknown>> = { http: {}, https: {}, http2: {}, global: {} };
    for (const [m, k] of KEYS) f[m][k] = function original() {};
    return f;
  };
  const snapshot = (f: Record<string, Record<string, unknown>>) =>
    KEYS.map(([m, k]) => [m, k, f[m][k], Object.getOwnPropertyDescriptor(f[m], k)]);
  const install = (f: Record<string, Record<string, unknown>>) =>
    installBackstop({ modules: { http: f.http, https: f.https, http2: f.http2 }, global: f.global });

  it.each(KEYS)('a %s.%s that can be neither written nor redefined: install fails and every fake is as it was', (m, k) => {
    const f = fakes();
    Object.defineProperty(f[m], k, { value: f[m][k], writable: false, configurable: false });
    const before = snapshot(f);
    expect(() => install(f)).toThrow('qbo-guard: install failed');
    expect(snapshot(f)).toEqual(before);
  });

  it('a fixed accessor: install fails and nothing is left replaced', () => {
    const f = fakes();
    Object.defineProperty(f.https, 'request', { get: () => function original() {}, configurable: false });
    const before = snapshot(f).filter(([m, k]) => !(m === 'https' && k === 'request'));
    expect(() => install(f)).toThrow('qbo-guard: install failed');
    expect(snapshot(f).filter(([m, k]) => !(m === 'https' && k === 'request'))).toEqual(before);
  });

  it('a writable property that cannot be redefined is replaced by assignment, and restore puts it back', () => {
    const f = fakes();
    const original = f.https.request;
    Object.defineProperty(f.https, 'request', { value: original, writable: true, configurable: false, enumerable: true });
    const restore = install(f);
    expect((f.https.request as any)[BACKSTOP_MARK]).toBe(true);
    restore();
    expect(f.https.request).toBe(original);
  });

  it('a missing property is added, and restore removes it; the rest come back as they were', () => {
    const f = fakes();
    delete f.global.WebSocket;
    const before = snapshot(f);
    const restore = install(f);
    expect(typeof f.global.WebSocket).toBe('function');
    expect(Object.getOwnPropertyDescriptor(f.global, 'WebSocket')?.enumerable).toBe(true);
    restore();
    expect(snapshot(f)).toEqual(before);
    expect('WebSocket' in f.global).toBe(false);
  });

  it('a wrapped https.request calls the function it replaced, with its arguments and receiver', () => {
    const f = fakes();
    const seen: unknown[] = [];
    f.https.request = function (this: unknown, ...args: unknown[]) {
      seen.push(this, ...args);
      return 'sent';
    };
    const restore = install(f);
    const out = runIssued(TICKET, () => (f.https.request as any).call(f.https, { ...OPTIONS }));
    restore();
    expect(out).toBe('sent');
    expect(seen).toEqual([f.https, { ...OPTIONS }]);
  });
});

describe('ESM imports under plain Node (A1.8, syncBuiltinESMExports)', () => {
  it('a named and a namespace import of node:https see the backstop', () => {
    assertFreshBuild();
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href, path.join(HERE, '..', '..', 'fixtures', 'esm-backstop.mjs')],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 20000 },
    );
    expect({ status: r.status, stdout: r.stdout }).toEqual({ status: 0, stdout: 'named: refused\nnamespace: refused\n' });
  });
});
