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
/** https.request as the backstop sees it, typed loosely: the cases pass option objects Node's types reject. */
const R = (...a: unknown[]) => (https.request as (...x: unknown[]) => any)(...a);
/** The guard's own agent (not exported): an https.Agent with rejectUnauthorized true. */
const GUARD_AGENT = expect.objectContaining({ options: expect.objectContaining({ rejectUnauthorized: true }) });
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
    runIssued(TICKET, () => refusedBackstop(() => R({ ...OPTIONS, ...change })));
    expect(net.calls).toHaveLength(0);
  });

  it('the two forms it reads go through under their ticket: a URL (string or URL object) and a plain or null-prototype options object', () => {
    runIssued(TICKET, () => https.request(P).end());
    runIssued(TICKET, () => https.request(new URL(P)).end());
    runIssued(TICKET, () => https.request({ host: 'quickbooks.api.intuit.com', path: PATH, method: 'get' }).end());
    runIssued(TICKET, () => https.request(Object.assign(Object.create(null), OPTIONS)).end());
    runIssued(TICKET, () => https.request({ ...OPTIONS }, () => {}).end());
    runIssued(TICKET, () => https.get(P));
    runIssued({ ...TICKET, path: '/' }, () => https.request({ hostname: 'quickbooks.api.intuit.com' }).end());
    expect(net.calls).toHaveLength(7);
    runIssued(TICKET, () => refusedBackstop(() => R({ ...OPTIONS, port: 443 })));
    runIssued(TICKET, () => refusedBackstop(() => https.request(undefined as any)));
    expect(net.calls).toHaveLength(7);
  });

  it('what Node gets is the compared reading, not the caller object', () => {
    const seen: unknown[] = [];
    const f = { https: { request: (...a: unknown[]) => (seen.push(a), 'sent') } as Record<string, unknown>, http: {}, http2: {}, global: {} };
    const restore = installBackstop({ modules: { http: f.http, https: f.https, http2: f.http2 }, global: f.global });
    const cb = () => {};
    const caller = { ...OPTIONS, headers: { Accept: 'application/json' }, agents: { http: 1 }, beforeRedirects: {}, family: 4 };
    runIssued(TICKET, () => (f.https.request as any)(caller, cb));
    runIssued(TICKET, () => (f.https.request as any)(P));
    restore();
    expect(seen).toEqual([
      [{ protocol: 'https:', hostname: 'quickbooks.api.intuit.com', port: 443, path: PATH, method: 'GET', insecureHTTPParser: false, agent: GUARD_AGENT, headers: Object.assign(Object.create(null), { Accept: 'application/json' }), family: 4 }, cb],
      [{ protocol: 'https:', hostname: 'quickbooks.api.intuit.com', port: 443, path: PATH, method: 'GET', insecureHTTPParser: false, agent: GUARD_AGENT }],
    ]);
    expect((seen[0] as unknown[])[0]).not.toBe(caller);
  });

  // task-3 TC1-TC4: calls Node would send somewhere else than the ticket says, each refused with nothing at the stub.
  const getter = (value: unknown) => {
    let reads = 0;
    return { enumerable: true, get: () => (reads++ === 0 ? value : 'evil.example.test') };
  };
  it.each([
    ['TC1a a URL with options over it (another host in the URL, host in options)', () => https.request(`https://evil.example.test${PATH}`, { host: 'quickbooks.api.intuit.com' })],
    ['TC1b a URL with hostname undefined over it', () => https.request(P, { hostname: undefined })],
    ['TC1b options with hostname null and no host', () => R({ ...OPTIONS, hostname: null })],
    ['TC1b options with no hostname or host', () => https.request({ path: PATH })],
    ['TC1c defaultPort', () => R({ ...OPTIONS, defaultPort: 8443 })],
    ['TC1c an agent with its own defaultPort', () => R({ ...OPTIONS, agent: new https.Agent({ defaultPort: 8443 } as any) })],
    ['TC1d path null', () => R({ ...OPTIONS, path: null })],
    ['TC2 a getter hostname', () => https.request(Object.defineProperty({ ...OPTIONS }, 'hostname', getter('quickbooks.api.intuit.com')))],
    ['TC2 a getter header', () => R({ ...OPTIONS, headers: Object.defineProperty({}, 'accept', getter('x')) })],
    ['a Proxy listing a key it does not hold', () => https.request(new Proxy({ ...OPTIONS }, { ownKeys: (t) => [...Reflect.ownKeys(t), 'extra'], getOwnPropertyDescriptor: (t, k) => Reflect.getOwnPropertyDescriptor(t, k) }) as any)],
    ['TC2 a class instance', () => https.request(Object.assign(new (class Opts {})(), OPTIONS))],
    ['TC3 socketPath', () => R({ ...OPTIONS, socketPath: '/tmp/x.sock' })],
    ['TC3 lookup', () => R({ ...OPTIONS, lookup: () => {} })],
    ['TC3 createConnection', () => R({ ...OPTIONS, createConnection: () => {} })],
    ['TC3 servername', () => R({ ...OPTIONS, servername: 'evil.example.test' })],
    ['TC3 rejectUnauthorized false', () => R({ ...OPTIONS, rejectUnauthorized: false })],
    ['TC3 checkServerIdentity', () => R({ ...OPTIONS, checkServerIdentity: () => undefined })],
    ['TC3 ca', () => R({ ...OPTIONS, ca: 'x' })],
    ['TC3 a foreign agent', () => R({ ...OPTIONS, agent: new https.Agent() })],
    ['TC3 a Host header', () => R({ ...OPTIONS, headers: { Host: 'evil.example.test' } })],
    ['an unknown option key', () => R({ ...OPTIONS, localPort: 1 })],
    ['a symbol option key', () => R({ ...OPTIONS, [Symbol('x')]: 1 })],
    ['auth', () => R({ ...OPTIONS, auth: 'a:b' })],
    ['insecureHTTPParser true', () => R({ ...OPTIONS, insecureHTTPParser: true })],
    ['protocol http:', () => R({ ...OPTIONS, protocol: 'http:' })],
    ['a URL with userinfo', () => https.request(`https://u:p@quickbooks.api.intuit.com${PATH}`)],
    ['an http URL', () => https.request(`http://quickbooks.api.intuit.com${PATH}`)],
    ['TC4 the port only in the URL', () => https.request(`https://quickbooks.api.intuit.com:8443${PATH}`)],
    ['TC4 another host only in the URL', () => https.request(`https://evil.example.test${PATH}`)],
    ['TC4 hostname and path inherited, not own', () => https.request(Object.create({ hostname: 'quickbooks.api.intuit.com', path: PATH }))],
    ['a second non-function argument', () => https.request({ ...OPTIONS }, 'x' as any)],
    ['a non-string method', () => R({ ...OPTIONS, method: 1 as any })],
    ['a non-string path', () => R({ ...OPTIONS, path: 1 as any })],
    ['an object port', () => R({ ...OPTIONS, port: {} as any })],
    ['headers that are an array', () => R({ ...OPTIONS, headers: [['accept', 'x']] as any })],
  ] as Array<[string, () => unknown]>)('under the ticket: %s is refused', (_what, call) => {
    runIssued(TICKET, () => refusedBackstop(call));
    expect(net.calls).toHaveLength(0);
  });

  it('a port given as the default and the keys axios adds that Node never reads pass', () => {
    runIssued({ ...TICKET, port: '443' }, () => R({ ...OPTIONS, port: 443, agents: {}, beforeRedirect: () => {}, http2Options: {}, maxBodyLength: Infinity, insecureHTTPParser: false, createConnection: undefined, auth: undefined }).end());
    expect(net.calls).toHaveLength(1);
  });

  it('TC6: a refused call is logged with the host Node would use (options over the URL)', () => {
    runIssued(TICKET, () => refusedBackstop(() => https.request(P, { hostname: 'other.example.test' })));
    expect(stderr).toEqual([`qbo-guard: refused GET https://other.example.test/v3/company/${REALM}/preferences (backstop)\n`]);
  });

  it('TC2: a Proxy whose get trap lies sends what its own properties hold (the snapshot), not what the trap says', () => {
    const lying = new Proxy({ ...OPTIONS }, { get: (t, k) => (k === 'hostname' ? 'evil.example.test' : (t as any)[k]) });
    runIssued(TICKET, () => https.request(lying).end());
    expect(net.calls.map((c) => c.hostname)).toEqual(['quickbooks.api.intuit.com']);
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

  it('TC5: a function carrying a forged marker is still replaced (idempotence is by its own wraps, not the marker)', () => {
    const f = fakes();
    for (const [m, k] of KEYS) Object.defineProperty(f[m][k] as object, BACKSTOP_MARK, { value: true });
    const before = snapshot(f);
    const restore = install(f);
    for (const [m, k] of KEYS) expect(f[m][k]).not.toBe(before.find(([bm, bk]) => bm === m && bk === k)![2]);
    restore();
    expect(snapshot(f)).toEqual(before);
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

  it('a wrapped https.request calls the function it replaced, with its receiver and the compared reading (not the caller object)', () => {
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
    expect(seen).toEqual([f.https, { protocol: 'https:', hostname: 'quickbooks.api.intuit.com', port: 443, path: PATH, method: 'GET', insecureHTTPParser: false, agent: GUARD_AGENT }]);
  });
});

describe('ESM imports under plain Node (A1.8, syncBuiltinESMExports)', () => {
  it('a named and a namespace import of node:https see the backstop, and the originals again after restore (TC5)', () => {
    assertFreshBuild();
    const r = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(path.join(ROOT, 'tests', 'fixtures', 'no-network.mjs')).href, path.join(HERE, '..', '..', 'fixtures', 'esm-backstop.mjs')],
      { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, timeout: 20000 },
    );
    expect({ status: r.status, stdout: r.stdout }).toEqual({
      status: 0,
      stdout: 'named: refused\nnamespace: refused\nafter restore, named: original\nafter restore, namespace: original\n',
    });
  });
});

describe('task-3 pass 2: what Node gets, and cases only one condition decides (TE1-TE5)', () => {
  /** Installs on fakes, runs fn under the ticket, returns what the replaced https.request got. */
  const sent = (call: (req: (...a: unknown[]) => unknown) => unknown, ticket = TICKET) => {
    const seen: unknown[][] = [];
    const f = { https: { request: (...a: unknown[]) => (seen.push(a), 'sent') } as Record<string, unknown>, http: {}, http2: {}, global: {} };
    const restore = installBackstop({ modules: { http: f.http, https: f.https, http2: f.http2 }, global: f.global });
    try {
      runIssued(ticket, () => call(f.https.request as (...a: unknown[]) => unknown));
    } finally {
      restore();
    }
    return seen;
  };

  it('TE1, TE5: Node always gets the guard agent, the strict parser, and every connection key as an own undefined', () => {
    const [[viaUrl], [viaOptions]] = [...sent((req) => req(P)), ...sent((req) => req({ ...OPTIONS }))] as unknown as Array<[Record<string, unknown>]>;
    for (const o of [viaUrl, viaOptions]) {
      expect(o.agent).toBeInstanceOf(https.Agent);
      expect(o.agent).not.toBe(https.globalAgent);
      expect((o.agent as any).options.rejectUnauthorized).toBe(true);
      expect(o.insecureHTTPParser).toBe(false);
      for (const k of ['createConnection', 'lookup', 'socketPath', 'defaultPort', 'localAddress', 'servername', 'setHost', 'rejectUnauthorized', 'ca', 'checkServerIdentity']) {
        expect({ k, own: Object.prototype.hasOwnProperty.call(o, k), value: o[k] }).toEqual({ k, own: true, value: undefined });
      }
    }
  });

  it("TE2: the headers Node gets are a copy, and timeout and signal pass through", () => {
    const headers = { Accept: 'application/json' };
    const signal = new AbortController().signal;
    const [[o]] = sent((req) => req({ ...OPTIONS, headers, timeout: 5, signal })) as unknown as Array<[Record<string, unknown>]>;
    expect(o.headers).not.toBe(headers);
    expect(o.headers).toEqual(Object.assign(Object.create(null), headers));
    expect(o.timeout).toBe(5);
    expect(o.signal).toBe(signal);
  });

  it.each([
    ['a URL with a username only', () => R(`https://u@quickbooks.api.intuit.com${PATH}`)],
    ['a URL with a password only', () => R(`https://:p@quickbooks.api.intuit.com${PATH}`)],
    ['localAddress', () => R({ ...OPTIONS, localAddress: '127.0.0.1' })],
    ['setHost', () => R({ ...OPTIONS, setHost: false })],
    ['hostname another host, host the ticket host (hostname wins)', () => R({ ...OPTIONS, hostname: 'evil.example.test', host: 'quickbooks.api.intuit.com' })],
    ['a boolean port', () => R({ ...OPTIONS, port: true })],
  ] as Array<[string, () => unknown]>)('TE3: under the ticket, %s is refused', (_what, call) => {
    runIssued(TICKET, () => refusedBackstop(call));
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ['an unknown key holding undefined', { localPort: undefined }],
    ['auth null', { auth: null }],
    ['hostname the ticket host, host another (hostname wins)', { host: 'evil.example.test' }],
  ] as Array<[string, Record<string, unknown>]>)('TE3: under the ticket, %s goes through', (_what, extra) => {
    runIssued(TICKET, () => R({ ...OPTIONS, ...extra }).end());
    expect(net.calls.map((c) => c.hostname)).toEqual(['quickbooks.api.intuit.com']);
  });

  it('TE4: a refused call that names no method logs GET (Node\'s default), and a read host an @ would move is not printed', () => {
    runIssued(TICKET, () => refusedBackstop(() => R({ hostname: 'quickbooks.api.intuit.com', path: '/other' })));
    runIssued(TICKET, () => refusedBackstop(() => R({ hostname: 'quickbooks.api.intuit.com', port: 'x@evil.example.test', path: PATH })));
    runIssued(TICKET, () => refusedBackstop(() => R(P, { path: '/x' })));
    expect(stderr).toEqual([
      'qbo-guard: refused GET https://quickbooks.api.intuit.com/other (backstop)\n',
      'qbo-guard: refused GET <unparsable url> (backstop)\n',
      'qbo-guard: refused GET https://quickbooks.api.intuit.com/x (backstop)\n',
    ]);
  });
});
