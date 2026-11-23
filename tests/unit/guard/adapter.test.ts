// Sanctuary Computer (quickbooks-mcp-291): the guard on the CommonJS axios instance, through the adapter, against a stub network over a socket trap.
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { trapNetwork } from '../../fakes/no-network.js';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { installStubNetwork, type StubAnswer, type StubCall } from '../../fakes/stub-network.js';
import {
  configureGuard,
  createCallScope,
  createGuard,
  currentTicket,
  defaultCallScope,
  guardedAxios,
  GuardRefusedError,
  installGuard,
} from '../../../src/http-guard.js';
import { newCallRecord, type GuardContext } from '../../../src/clients/guard-decide.js';

const trap = trapNetwork();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const EX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fakes/guard-examples.json'), 'utf8'));
const requireHere = createRequire(import.meta.url);
const QuickBooks = requireHere('node-quickbooks');

const REALM = '9990000000000002';
const Q = `https://quickbooks.api.intuit.com/v3/company/${REALM}`;
const S = 'https://stacks.example.test/api/qbo/access_token';
const P = `${Q}/preferences?minorversion=75&format=json`;
const P1: string = EX.requestIds.P1.url;
const fakeToken = (n = '') => 'qbo-fake-' + 'token' + n;
const QR = JSON.stringify({ QueryResponse: {} });

let answer: (call: StubCall) => StubAnswer | Promise<StubAnswer> = () => ({ status: 200, body: QR });
const tickets: unknown[] = [];
const net = installStubNetwork((call) => {
  tickets.push(currentTicket());
  return answer(call);
});
const scope = createCallScope();
const BASE: GuardContext = {
  stacksUrl: 'https://stacks.example.test',
  keys: () => [...EX.context.keys],
  allowedRealm: (r) => scope.allowedRealm(r),
  callRecord: () => scope.callRecord(),
};
const guard = createGuard(BASE);
let restoreGuard = installGuard(guard);
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
  tickets.length = 0;
  answer = () => ({ status: 200, body: QR });
  createGuard(BASE); // a test that switched the context gets the base one back
});
afterAll(() => {
  restoreGuard();
  net.restore();
  trap.restore();
});

/** Runs fn inside a call for `realm`. */
const inCall = <T>(fn: () => Promise<T>, realm: string | null = REALM): Promise<T> =>
  scope.run(async () => {
    if (realm !== null) scope.setRealm(realm);
    return fn();
  });
const client = (realm = REALM) => new QuickBooks('id', 'secret', fakeToken(), false, realm, false, false, null, '2.0', 'r');
const refusedWith = async (p: Promise<unknown>, rule: string) => {
  await expect(p).rejects.toMatchObject({ name: 'GuardRefusedError', rule });
};
const sentTo = (url: string) => {
  const w = new URL(url);
  return { hostname: w.hostname, path: w.pathname + w.search };
};

describe('hook identity (A1.1, its createGuard/installGuard part)', () => {
  it('the guard is the adapter of the CommonJS instance node-quickbooks loads', () => {
    const nq = createRequire(requireHere.resolve('node-quickbooks'))('axios');
    expect(ax).toBe(nq);
    expect(ax.defaults.adapter).toBe(guard.adapter);
    expect(installGuard(guard)).toBe(restoreGuard);
  });

  it('a node-quickbooks call through a fake-token client reaches the stub once, as the guard decided', async () => {
    const out = await inCall(
      () => new Promise((resolve, reject) => client().findAccounts([{ field: 'limit', value: 10 }], (err: unknown, data: unknown) => (err ? reject(err) : resolve(data)))),
    );
    expect(out).toBeDefined();
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ module: 'https', method: 'GET', hostname: 'quickbooks.api.intuit.com' });
    expect(net.calls[0].path).toBe(`/v3/company/${REALM}/query?query=select%20*%20from%20account%20startposition%201%20maxresults%2010&minorversion=75&format=json`);
  });

  it("node-quickbooks' text with inner spaces passes the getUri check and is sent as W (T0's recorded path)", async () => {
    await inCall(
      () =>
        new Promise((resolve, reject) =>
          client().findPurchases([{ field: 'PaymentType', value: "Cash's", operator: '=' }, { field: 'limit', value: 10 }], (err: unknown, d: unknown) =>
            err ? reject(err) : resolve(d),
          ),
        ),
    );
    expect(net.calls.map((c) => c.path)).toEqual([
      `/v3/company/${REALM}/query?query=select%20*%20from%20purchase%20where%20PaymentType%20%3D%20%27Cash%5C%27s%27%20startposition%201%20maxresults%2010&minorversion=75&format=json`,
    ]);
    expect(scope.callRecord()).toBeUndefined();
  });

  it('the request goes out under a single-use ticket for exactly what was decided', async () => {
    await inCall(() => ax.get(P));
    expect(tickets).toEqual([{ method: 'GET', hostname: 'quickbooks.api.intuit.com', port: '', path: `/v3/company/${REALM}/preferences?minorversion=75&format=json`, used: false }]);
  });
});

describe('contract rows through the adapter (A1.2)', () => {
  it.each(EX.examples.map((r: any) => [r.decision, r.case, r]) as Array<[string, string, any]>)('%s: %s', async (_d, _c, row) => {
    const p = inCall(() => ax.request({ method: row.method, url: row.url }));
    if (row.decision === 'allow') {
      await p;
      expect(net.calls).toHaveLength(1);
      expect(net.calls[0]).toMatchObject(sentTo(row.url));
    } else {
      await expect(p).rejects.toBeInstanceOf(GuardRefusedError);
      expect(net.calls).toHaveLength(0);
    }
  });

  it.each(EX.callExamples.map((r: any) => [r.decision, r.case, r]) as Array<[string, string, any]>)('call row %s: %s', async (_d, _c, row) => {
    const statuses = row.requests.map((r: any) => r.status ?? 200);
    let n = 0;
    answer = () => ({ status: statuses[n++] });
    const outcomes = await inCall(async () => {
      const out: string[] = [];
      for (const r of row.requests) {
        try {
          await ax.get(EX.requestIds[r.id].url);
          out.push('sent');
        } catch (e) {
          out.push(e instanceof GuardRefusedError ? 'refused' : 'sent');
        }
      }
      return out;
    });
    expect(outcomes.slice(0, -1).every((o) => o === 'sent')).toBe(true);
    expect(outcomes[outcomes.length - 1]).toBe(row.decision === 'allow' ? 'sent' : 'refused');
    expect(net.calls).toHaveLength(row.decision === 'allow' ? row.requests.length : row.requests.length - 1);
  });
});

describe("done-when 1's named refusals (A1.3)", () => {
  it.each([
    ['a POST', 'post', P, 'quickbooks'],
    ['a PUT', 'put', P, 'quickbooks'],
    ['a DELETE', 'delete', P, 'quickbooks'],
    ['?operation=delete', 'get', `${Q}/purchase?operation=delete&minorversion=75&format=json`, 'quickbooks'],
    ['/batch', 'get', `${Q}/batch?minorversion=75&format=json`, 'refused'],
    ['/cdc', 'get', `${Q}/cdc?entities=Purchase&minorversion=75&format=json`, 'quickbooks'],
    ['/upload', 'get', `${Q}/upload?minorversion=75&format=json`, 'refused'],
    ['a sandbox host', 'get', `https://sandbox-quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`, 'refused'],
    ['oauth.platform.intuit.com', 'get', 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', 'refused'],
    ['purchase/5', 'get', `${Q}/purchase/5?minorversion=75&format=json`, 'entity-by-id'],
    ['a realm the callback rejects', 'get', 'https://quickbooks.api.intuit.com/v3/company/9990000000000001/preferences?minorversion=75&format=json', 'quickbooks'],
    ['(a) an http:// Stacks request', 'get', 'http://stacks.example.test/api/qbo/access_token?enterprise=garden3d', 'raw-text'],
  ])('%s', async (_what, method, url, rule) => {
    await refusedWith(inCall(() => ax.request({ method, url })), rule);
    expect(net.calls).toHaveLength(0);
  });

  it('(b) a guard configured with an http:// STACKS_QBO_URL refuses its own form: stacks-config', async () => {
    createGuard({ ...BASE, stacksUrl: 'http://stacks.example.test' });
    await refusedWith(ax.get('http://stacks.example.test/api/qbo/access_token?enterprise=garden3d'), 'stacks-config');
    expect(net.calls).toHaveLength(0);
  });
});

describe("the guard's own rules through the adapter (A1.5)", () => {
  it.each([['{}'], [{ a: 1 }]])('body: data %j on an allowed GET is refused', async (data) => {
    await refusedWith(inCall(() => ax.request({ method: 'get', url: P, data })), 'body');
    await refusedWith(ax.request({ method: 'get', url: `${S}?enterprise=garden3d`, data }), 'body');
    expect(net.calls).toHaveLength(0);
  });

  it.each([[undefined], [null], ['']])('body: data %j is no body', async (data) => {
    await inCall(() => ax.request({ method: 'get', url: P, data }));
    await ax.request({ method: 'get', url: `${S}?enterprise=garden3d`, data });
    expect(net.calls).toHaveLength(2);
  });

  it('credential-crossing: X-Api-Key to QuickBooks, Authorization to Stacks, any case', async () => {
    for (const h of ['X-Api-Key', 'x-api-key']) {
      await refusedWith(inCall(() => ax.get(P, { headers: { [h]: fakeToken() } })), 'credential-crossing');
    }
    for (const h of ['Authorization', 'authorization']) {
      await refusedWith(ax.get(`${S}?enterprise=garden3d`, { headers: { [h]: 'Bearer ' + fakeToken() } }), 'credential-crossing');
    }
    expect(net.calls).toHaveLength(0);
    await inCall(() => ax.get(P, { headers: { Authorization: 'Bearer ' + fakeToken() } }));
    await ax.get(`${S}?enterprise=garden3d`, { headers: { 'X-Api-Key': fakeToken() } });
    expect(net.calls).toHaveLength(2);
  });

  it.each([
    ['http://stacks.example.test', 'stacks-config'],
    ['https://user@stacks.example.test', 'stacks-config'],
    ['https://:pw@stacks.example.test', 'stacks-config'],
    ['https://stacks.example.test/x', 'stacks-config'],
    ['https://stacks.example.test/?a=1', 'stacks-config'],
    ['', 'stacks-config'],
    ['not a url', 'stacks-config'],
    [undefined, 'refused'],
  ])('stacks-config: STACKS_QBO_URL %j refuses the Stacks form with %s', async (stacksUrl, rule) => {
    createGuard({ ...BASE, stacksUrl });
    await refusedWith(ax.get(`${S}?enterprise=garden3d`), rule);
    expect(net.calls).toHaveLength(0);
  });
});

describe('redirects (A1.6, the stub alone)', () => {
  it.each([[P], [`${S}?enterprise=garden3d`]])('a 302 from %s is an error, not followed', async (url) => {
    answer = () => ({ status: 302, headers: { Location: P } });
    await expect(inCall(() => ax.get(url))).rejects.toMatchObject({ response: { status: 302 } });
    expect(net.calls).toHaveLength(1);
  });
});

describe('transport pins (A1.7)', () => {
  it('every transport key comes from the guard, never the request', async () => {
    const transport = { request: jest.fn() };
    const lookup = jest.fn();
    const beforeRedirect = jest.fn();
    await inCall(() =>
      ax.request({
        method: 'get',
        url: `${Q}/preferences`,
        params: { minorversion: 75, format: 'json' },
        proxy: { protocol: 'http', host: '127.0.0.1', port: 9 },
        socketPath: '/nonexistent/qbo-guard.sock',
        transport,
        baseURL: 'https://evil.example.test/',
        httpAgent: new http.Agent(),
        httpsAgent: https.globalAgent,
        beforeRedirect,
        lookup,
        family: 6,
        httpVersion: 2,
        unknownKey: 1,
      } as any),
    );
    expect(net.calls).toHaveLength(1);
    const c = net.calls[0];
    expect(c).toMatchObject({ module: 'https', hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${REALM}/preferences?minorversion=75&format=json` });
    expect(c.agent).not.toBe(https.globalAgent);
    expect(c.agent).toBeInstanceOf(https.Agent);
    expect((c.agent as any).options.rejectUnauthorized).toBe(true);
    expect(c.options.socketPath).toBeUndefined();
    expect(c.options.lookup).toBeUndefined();
    expect(c.options.family).toBeUndefined();
    expect(transport.request).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(beforeRedirect).not.toHaveBeenCalled();
  });

  it.each([['a function', () => jest.fn()], ['http', () => 'http'], ['fetch', () => 'fetch'], ['null', () => null]])(
    'a per-request adapter (%s) is refused by the interceptor',
    async (_what, make) => {
      const adapter = make();
      await refusedWith(inCall(() => ax.request({ url: P, adapter } as any)), 'transport');
      if (typeof adapter === 'function') expect(adapter).not.toHaveBeenCalled();
      expect(net.calls).toHaveLength(0);
      expect(stderr).toEqual([`qbo-guard: refused GET https://quickbooks.api.intuit.com/v3/company/${REALM}/preferences (transport)\n`]);
    },
  );
});

describe("the adapter's catch-all (A1.11)", () => {
  it('a throw in getUri is guard-error, nothing sent, nothing recorded', async () => {
    jest.spyOn(ax, 'getUri').mockImplementation(() => {
      throw new Error('boom');
    });
    const rec = await inCall(async () => {
      await refusedWith(ax.get(P1), 'guard-error');
      return scope.callRecord();
    });
    expect(rec?.queries).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it('a getUri text that differs from the decided text is guard-error', async () => {
    jest.spyOn(ax, 'getUri').mockReturnValue(`${P}&x=1`);
    await refusedWith(inCall(() => ax.get(P)), 'guard-error');
    expect(net.calls).toHaveLength(0);
  });

  it('a throw in getAdapter is guard-error, nothing sent, nothing recorded', async () => {
    jest.spyOn(ax, 'getAdapter').mockImplementation(() => {
      throw new Error('boom');
    });
    const rec = await inCall(async () => {
      await refusedWith(ax.get(P1), 'guard-error');
      return scope.callRecord();
    });
    expect(rec?.queries).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it('a throw while building the send config is guard-error', async () => {
    const config: Record<string, unknown> = { method: 'get', url: P, headers: new ax.AxiosHeaders() };
    Object.defineProperty(config, 'responseType', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    await refusedWith(inCall(() => guard.adapter(config)), 'guard-error');
    expect(net.calls).toHaveLength(0);
  });

  it('a call record that disappears between the decision and the append is guard-error', async () => {
    const rec = newCallRecord();
    let n = 0;
    configureGuard({ allowedRealm: (r) => r === REALM, callRecord: () => (n++ === 0 ? rec : undefined) });
    await refusedWith(ax.get(P1), 'guard-error');
    expect(rec.queries).toEqual([]);
    expect(net.calls).toHaveLength(0);
  });

  it('a config with no method or url is guard-error, logged as OTHER and <unparsable url>', async () => {
    await refusedWith(guard.adapter({ headers: new ax.AxiosHeaders() }), 'guard-error');
    await refusedWith(guard.adapter(null), 'guard-error');
    expect(stderr[0]).toBe('qbo-guard: refused OTHER <unparsable url> (guard-error)\n');
    expect(net.calls).toHaveLength(0);
  });
});

describe('refusal log (A1.12)', () => {
  it('no token, no query, no userinfo, no raw text', async () => {
    const t = fakeToken('-log');
    await refusedWith(inCall(() => ax.post(`${Q}/query?query=select%20*%20from%20purchase%20where%20Memo%20%3D%20%27criteriavalue%27%20maxresults%2010${'&minorversion=75&format=json'}`, undefined, { headers: { Authorization: 'Bearer ' + t } })), 'quickbooks');
    await refusedWith(inCall(() => ax.get(`https://user:pw@quickbooks.api.intuit.com/v3/company/${REALM}/preferences?minorversion=75&format=json`)), 'raw-text');
    await refusedWith(ax.get('not a url?criteriavalue=1'), 'guard-error');
    await refusedWith(inCall(() => ax.request({ method: 'BREW', url: P })), 'quickbooks');
    expect(stderr).toEqual([
      `qbo-guard: refused POST https://quickbooks.api.intuit.com/v3/company/${REALM}/query (quickbooks)\n`,
      `qbo-guard: refused GET https://quickbooks.api.intuit.com/v3/company/${REALM}/preferences (raw-text)\n`,
      'qbo-guard: refused GET <unparsable url> (guard-error)\n',
      `qbo-guard: refused OTHER https://quickbooks.api.intuit.com/v3/company/${REALM}/preferences (quickbooks)\n`,
    ]);
    const all = stderr.join('');
    for (const s of [t, 'criteriavalue', 'user', 'pw@', 'minorversion', 'BREW']) expect(all).not.toContain(s);
  });

  it('the host keeps its port and drops userinfo', async () => {
    await refusedWith(ax.get('https://u:p@other.example.test:8443/x?y=1'), 'refused');
    expect(stderr).toEqual(['qbo-guard: refused GET https://other.example.test:8443/x (refused)\n']);
  });

  it("GuardRefusedError's message names the rule only", async () => {
    const err = await inCall(() => ax.post(P)).catch((e) => e);
    expect(err).toBeInstanceOf(GuardRefusedError);
    expect(err.name).toBe('GuardRefusedError');
    expect(err.message).toBe('qbo-guard: refused (quickbooks)');
  });

  it('a log that cannot be written still refuses', async () => {
    (process.stderr.write as any).mockImplementation(() => {
      throw new Error('EPIPE');
    });
    await refusedWith(inCall(() => ax.post(P)), 'quickbooks');
    expect(net.calls).toHaveLength(0);
  });
});

describe('resend through the instance (A1.14)', () => {
  it('P1 [401], P1 resent with a new token: allowed once; after a second 401 a third is refused; statuses recorded', async () => {
    answer = () => ({ status: 401 });
    const rec = await inCall(async () => {
      await expect(ax.get(P1, { headers: { Authorization: 'Bearer ' + fakeToken('1') } })).rejects.toMatchObject({ response: { status: 401 } });
      await expect(ax.get(P1, { headers: { Authorization: 'Bearer ' + fakeToken('2') } })).rejects.toMatchObject({ response: { status: 401 } });
      await refusedWith(ax.get(P1, { headers: { Authorization: 'Bearer ' + fakeToken('3') } }), 'query');
      return scope.callRecord();
    });
    expect(net.calls).toHaveLength(2);
    expect(rec?.queries.map((q) => [q.entity, q.status])).toEqual([
      ['purchase', 401],
      ['purchase', 401],
    ]);
    expect(rec?.queries[0].url).toBe(new URL(P1).href);
  });

  it('a 200 is recorded, and a network error with no response records null', async () => {
    answer = () => {
      throw new Error('ECONNRESET');
    };
    const rec = await inCall(async () => {
      await ax.get(EX.requestIds.B1.url).catch(() => undefined);
      answer = () => ({ status: 200, body: QR });
      await ax.get(P1);
      return scope.callRecord();
    });
    expect(rec?.queries.map((q) => [q.entity, q.status])).toEqual([
      ['bill', null],
      ['purchase', 200],
    ]);
  });
});

describe('configureGuard (A1.15, on a guard createGuard built)', () => {
  it('replaces the callbacks it is given, leaves the others and never stacksUrl', async () => {
    createGuard({ ...BASE, keys: () => [] });
    await refusedWith(ax.get(`${S}?enterprise=garden3d`), 'stacks');
    configureGuard({ keys: () => ['garden3d'] });
    await ax.get(`${S}?enterprise=garden3d`);
    await refusedWith(ax.get(`${S}?enterprise=usb-club`), 'stacks');

    const rec = newCallRecord();
    configureGuard({ allowedRealm: (r) => r === '9990000000000004', callRecord: () => rec });
    await ax.get('https://quickbooks.api.intuit.com/v3/company/9990000000000004/preferences?minorversion=75&format=json');
    await refusedWith(inCall(() => ax.get(P)), 'quickbooks');
    await ax.get(`${S}?enterprise=garden3d`); // keys and stacksUrl untouched
    configureGuard({ stacksUrl: 'https://other.example.test' } as any);
    await ax.get(`${S}?enterprise=garden3d`);
    expect(net.calls.map((c) => c.hostname)).toEqual(['stacks.example.test', 'quickbooks.api.intuit.com', 'stacks.example.test', 'stacks.example.test']);
  });

  it('a callback that is not a function is refused, and nothing is replaced', async () => {
    expect(() => configureGuard({ keys: () => ['garden3d'], allowedRealm: 'yes' as any })).toThrow(TypeError);
    createGuard({ ...BASE, keys: () => [] });
    expect(() => configureGuard({ keys: () => ['garden3d'], callRecord: 1 as any })).toThrow(TypeError);
    await refusedWith(ax.get(`${S}?enterprise=garden3d`), 'stacks');
  });

  it('defaultCallScope throws before start', () => {
    expect(() => defaultCallScope()).toThrow('qbo-guard: not started');
  });
});

describe('installGuard', () => {
  it('restore puts the previous adapter back and drops the interceptor; a second restore does nothing', async () => {
    const other = createGuard(BASE);
    const restoreOther = installGuard(other);
    expect(ax.defaults.adapter).toBe(other.adapter);
    await refusedWith(inCall(() => ax.request({ url: P, adapter: guard.adapter } as any)), 'transport');
    restoreOther();
    restoreOther();
    expect(ax.defaults.adapter).toBe(guard.adapter);
    await inCall(() => ax.get(P));
    expect(net.calls).toHaveLength(1);
  });
});

describe('task-2 review: cases only one condition decides (TB1-TB10)', () => {
  it('TB1: a transformRequest that swaps the adapter after the interceptor sends nothing undecided', async () => {
    const swap = function (this: any, d: unknown) {
      this.adapter = 'http';
      this.maxRedirects = 0;
      return d;
    };
    const p = inCall(() => ax.request({ method: 'post', url: 'https://other.example.test/upload', data: 'x', transformRequest: [swap] } as any));
    await refusedWith(p, 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it('TB1: an instance made with create() refuses a per-request adapter, and sends an allowed request through the guard', async () => {
    const made = ax.create();
    await refusedWith(inCall(() => made.request({ url: P, adapter: 'http' } as any)), 'transport');
    await refusedWith(inCall(() => made.request({ method: 'post', url: 'https://other.example.test/upload', data: 'x', adapter: 'http' } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
    await inCall(() => made.get(P));
    expect(tickets).toHaveLength(1);
    expect(net.calls).toHaveLength(1);
  });

  it('TB2: with HTTPS_PROXY set, the request still goes straight to QuickBooks with the guard agent', async () => {
    const before = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    try {
      await inCall(() => ax.get(P));
    } finally {
      if (before === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = before;
    }
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]).toMatchObject({ module: 'https', hostname: 'quickbooks.api.intuit.com', path: `/v3/company/${REALM}/preferences?minorversion=75&format=json` });
    expect(net.calls[0].agent).toBeInstanceOf(https.Agent);
    expect((net.calls[0].agent as any).options.rejectUnauthorized).toBe(true);
  });

  it("TB3: a 302 is not followed even when the request asks for maxRedirects 5", async () => {
    answer = () => ({ status: 302, headers: { Location: P } });
    await expect(inCall(() => ax.get(P, { maxRedirects: 5 }))).rejects.toMatchObject({ response: { status: 302 } });
    expect(net.calls).toHaveLength(1);
  });

  it("TB4: a request's auth is dropped: no auth option and no Authorization header reach the network", async () => {
    await ax.get(`${S}?enterprise=garden3d`, { auth: { username: 'u', password: 'qbo-fake-' + 'pass' } });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].options.auth).toBeUndefined();
    expect(Object.keys(net.calls[0].headers ?? {}).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  // An adapter config the way axios builds one, with `method` or `url` as an accessor (axios' merge never makes one).
  const configWith = (key: 'method' | 'url', get: () => unknown) =>
    Object.defineProperty({ ...ax.defaults, headers: {}, method: 'get', url: P }, key, { get, enumerable: true, configurable: true });

  it('TB5: a method that answers get once and post after is decided, sent and ticketed as GET', async () => {
    let reads = 0;
    await inCall(() => guard.adapter(configWith('method', () => (reads++ === 0 ? 'get' : 'post'))));
    expect(net.calls.map((c) => c.method)).toEqual(['GET']);
    expect(tickets).toMatchObject([{ method: 'GET' }]);
  });

  it.each([['url'], ['method']] as Array<['url' | 'method']>)('TB6: a %s getter that throws is guard-error, nothing sent', async (key) => {
    await refusedWith(
      inCall(() =>
        guard.adapter(
          configWith(key, () => {
            throw new Error('boom');
          }),
        ),
      ),
      'guard-error',
    );
    expect(net.calls).toHaveLength(0);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^qbo-guard: refused [A-Z]+ <unparsable url> \(guard-error\)\n$/);
  });

  it('TB7: the interceptor compares with the guard, not with whatever defaults.adapter now holds', async () => {
    const swapped = jest.fn();
    const previous = ax.defaults.adapter;
    ax.defaults.adapter = swapped as any;
    try {
      await refusedWith(inCall(() => ax.get(P)), 'transport');
    } finally {
      ax.defaults.adapter = previous;
    }
    expect(swapped).not.toHaveBeenCalled();
    expect(net.calls).toHaveLength(0);
  });

  it('TB8: after restore the same guard installs again with a new restore; the old, stale restore changes nothing', async () => {
    const g2 = createGuard(BASE);
    const first = installGuard(g2);
    first();
    const second = installGuard(g2);
    expect(second).not.toBe(first);
    expect(ax.defaults.adapter).toBe(g2.adapter);
    await refusedWith(inCall(() => ax.request({ url: P, adapter: guard.adapter } as any)), 'transport');
    first();
    expect(ax.defaults.adapter).toBe(g2.adapter);
    await refusedWith(inCall(() => ax.request({ url: P, adapter: guard.adapter } as any)), 'transport');
    second();
    expect(ax.defaults.adapter).toBe(guard.adapter);
    await inCall(() => ax.get(P));
    expect(net.calls).toHaveLength(1);
  });

  it('TB9: the ticket carries the URL port and the hostname without it', async () => {
    createGuard({ ...BASE, stacksUrl: 'https://stacks.example.test:8443' });
    await ax.get('https://stacks.example.test:8443/api/qbo/access_token?enterprise=garden3d');
    expect(tickets).toEqual([{ method: 'GET', hostname: 'stacks.example.test', port: '8443', path: '/api/qbo/access_token?enterprise=garden3d', used: false }]);
  });

  it("TB10: a data: URL's payload is not printed; the line says <unparsable url>", async () => {
    await expect(ax.get('data:application/json,%7B%22k%22%3A%22opaque%22%7D')).rejects.toBeInstanceOf(GuardRefusedError);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^qbo-guard: refused GET <unparsable url> \([a-z-]+\)\n$/);
    expect(stderr[0]).not.toContain('opaque');
  });
});

describe("TB1: the guard's last transform, whatever form transformRequest arrives in", () => {
  // An interceptor added after install runs before the guard's, so it can hand the guard any transformRequest form.
  const withTransform = async (value: unknown) => {
    const id = ax.interceptors.request.use((config: any) => {
      config.transformRequest = value;
      return config;
    });
    try {
      return await inCall(() => ax.get(P));
    } finally {
      ax.interceptors.request.eject(id);
    }
  };

  it('a single function is kept and runs before the check; undefined and null are an empty list', async () => {
    const single = jest.fn((d: unknown) => d);
    await withTransform(single);
    expect(single).toHaveBeenCalledTimes(1);
    await withTransform(undefined);
    await withTransform(null);
    expect(net.calls).toHaveLength(3);
  });

  it('a single function that swaps the adapter is refused (transport), nothing sent', async () => {
    await refusedWith(
      withTransform(function (this: any, d: unknown) {
        this.adapter = 'http';
        return d;
      }),
      'transport',
    );
    expect(net.calls).toHaveLength(0);
  });
});

describe('task-2 pass 2: the guard transform, interceptor order, every instance (TF1-TF6)', () => {
  const UPLOAD = { method: 'post', url: 'https://other.example.test/upload', data: 'x' };
  /** Refused, or thrown: either way nothing reaches the stub and nothing is ticketed. */
  const notSent = async (p: Promise<unknown>) => {
    await expect(p).rejects.toBeDefined();
    expect(net.calls).toHaveLength(0);
    expect(tickets).toHaveLength(0);
  };

  it('TF1 (A): an adapter accessor that answers the guard once and http after is refused transport', async () => {
    const t = function (this: any, d: unknown) {
      let reads = 0;
      Object.defineProperty(this, 'adapter', { get: () => (reads++ === 0 ? guard.adapter : 'http'), configurable: true, enumerable: true });
      return d;
    };
    await refusedWith(inCall(() => ax.request({ ...UPLOAD, transformRequest: [t] } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it("TF1 (B): overwriting the guard's transform in this.transformRequest, then swapping the adapter, is refused", async () => {
    const t = function (this: any, d: unknown) {
      try {
        this.transformRequest[this.transformRequest.length - 1] = (x: unknown) => x;
      } catch {
        // the guard's list is frozen
      }
      this.adapter = 'http';
      return d;
    };
    await refusedWith(inCall(() => ax.request({ ...UPLOAD, transformRequest: [t] } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ['redefines', (self: any) => Object.defineProperty(self, 'adapter', { value: 'http', writable: true, configurable: true, enumerable: true })],
    ['deletes', (self: any) => delete self.adapter],
  ] as Array<[string, (self: any) => void]>)('TG5: a method getter that %s the pinned adapter sends nothing', async (_what, swap) => {
    const t = function (this: any, d: unknown) {
      Object.defineProperty(this, 'method', {
        get: () => {
          swap(this);
          return 'post';
        },
        configurable: true,
        enumerable: true,
      });
      return d;
    };
    await notSent(inCall(() => ax.request({ ...UPLOAD, transformRequest: [t] } as any)));
  });

  it.each([
    ['method', 'qbo-guard: refused OTHER https://other.example.test/upload (transport)\n'],
    ['url', 'qbo-guard: refused POST <unparsable url> (transport)\n'],
  ] as Array<[string, string]>)('TG4: a swapped adapter with a %s getter that throws is still refused transport, not the raw error', async (key, line) => {
    const t = function (this: any, d: unknown) {
      this.adapter = 'http';
      Object.defineProperty(this, key, {
        get: () => {
          throw new Error('boom-method');
        },
        configurable: true,
        enumerable: true,
      });
      return d;
    };
    await refusedWith(inCall(() => ax.request({ ...UPLOAD, transformRequest: [t] } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
    expect(stderr).toEqual([line]);
  });

  it('TF1 (C): a method getter that swaps the adapter after the transforms sends nothing (the adapter is pinned)', async () => {
    const t = function (this: any, d: unknown) {
      Object.defineProperty(this, 'method', {
        get: () => {
          this.adapter = 'http';
          return 'post';
        },
        configurable: true,
        enumerable: true,
      });
      return d;
    };
    await notSent(inCall(() => ax.request({ ...UPLOAD, transformRequest: [t] } as any)));
  });

  it("TF1: a transform that deletes the adapter, or one that can't be pinned, is refused transport", async () => {
    const del = function (this: any, d: unknown) {
      delete this.adapter;
      return d;
    };
    await refusedWith(inCall(() => ax.request({ ...UPLOAD, transformRequest: [del] } as any)), 'transport');
    const unpinnable = function (this: any, d: unknown) {
      Object.defineProperty(this, 'adapter', { value: guard.adapter, writable: false, configurable: false, enumerable: false });
      return d;
    };
    await refusedWith(inCall(() => ax.request({ ...UPLOAD, transformRequest: [unpinnable] } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it("TF1: the given transforms run in order, with the request's data and headers, before the guard decides", async () => {
    const order: string[] = [];
    const one = (d: unknown, h: any) => (order.push(`one:${d}:${typeof h.set}`), undefined);
    const two = function (this: any, d: unknown) {
      order.push(`two:${d}:${this.url === P}`);
      return d;
    };
    await inCall(() => ax.get(P, { transformRequest: [one, two] } as any));
    expect(order).toEqual(['one:undefined:function', 'two:undefined:true']);
    expect(net.calls).toHaveLength(1);
  });

  it.each([[false], [undefined]])('TF2: a request whose transitional.legacyInterceptorReqResOrdering is %j is refused transport', async (value) => {
    await refusedWith(inCall(() => ax.get(P, { transitional: { legacyInterceptorReqResOrdering: value } } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it('TF2: with the other order refused, an interceptor added later cannot run after the guard', async () => {
    const id = ax.interceptors.request.use((config: any) => {
      config.transformRequest = [];
      config.adapter = 'http';
      return config;
    });
    try {
      await refusedWith(inCall(() => ax.request({ ...UPLOAD, transitional: { legacyInterceptorReqResOrdering: false } } as any)), 'transport');
    } finally {
      ax.interceptors.request.eject(id);
    }
    expect(net.calls).toHaveLength(0);
  });

  it('TF3: an instance made by create() on a created instance refuses a per-request adapter, and sends through the guard', async () => {
    const made = ax.create().create();
    await refusedWith(inCall(() => made.request({ ...UPLOAD, adapter: 'http' } as any)), 'transport');
    expect(net.calls).toHaveLength(0);
    await inCall(() => made.get(P));
    expect(net.calls).toHaveLength(1);
  });

  it.each([
    ['request(config)', (a: any) => a.request({ ...UPLOAD, adapter: 'http' }), 'POST https://other.example.test/upload'],
    ['get(url)', (a: any) => a.get('https://other.example.test/x'), 'GET https://other.example.test/x'],
    ['request(url, config)', (a: any) => a.request('https://other.example.test/y', { method: 'put' }), 'PUT https://other.example.test/y'],
    ['request(url)', (a: any) => a.request('https://other.example.test/w'), 'GET https://other.example.test/w'],
  ] as Array<[string, (a: any) => Promise<unknown>, string]>)('TF3: a bare new Axios() context is refused transport: %s', async (_what, call, line) => {
    const bare = new (ax as any).Axios({});
    await refusedWith(inCall(() => call(bare)), 'transport');
    expect(net.calls).toHaveLength(0);
    expect(stderr).toEqual([`qbo-guard: refused ${line} (transport)\n`]);
  });

  it('TF3: a bare context given a config that throws on read is still refused, logged as unparsable', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    );
    await refusedWith(inCall(() => new (ax as any).Axios({}).request(hostile)), 'transport');
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^qbo-guard: refused \S+ <unparsable url> \(transport\)\n$/);
  });

  it('TF3: after restore, a bare Axios context and an instance made under the guard send as plain axios', async () => {
    const own = jest.fn(async (c: any) => ({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config: c }));
    const made = ax.create({ adapter: own as any });
    restoreGuard();
    try {
      await expect(made.get('https://other.example.test/x')).resolves.toMatchObject({ data: 'ok' });
      await expect(made.request({ url: 'https://other.example.test/y' })).resolves.toMatchObject({ data: 'ok' });
      await expect(new (ax as any).Axios({ adapter: own }).get('https://other.example.test/z')).resolves.toMatchObject({ data: 'ok' });
    } finally {
      restoreGuard = installGuard(guard);
    }
    expect(own).toHaveBeenCalledTimes(3);
    expect(net.calls).toHaveLength(0);
  });

  it("TF3 (mutant 8): a per-request adapter is refused before any of the request's transforms runs", async () => {
    const t = jest.fn(function (this: any, d: unknown) {
      this.adapter = guard.adapter;
      return d;
    });
    await refusedWith(inCall(() => ax.request({ url: P, adapter: 'http', transformRequest: [t] } as any)), 'transport');
    expect(t).not.toHaveBeenCalled();
    expect(net.calls).toHaveLength(0);
  });

  it('TF3 (mutants 10, 14): restore puts Axios.prototype.request back, and a stale reference to the guard request passes through', async () => {
    const proto = (ax as any).Axios.prototype;
    const before = proto._request;
    const own = jest.fn(async (c: any) => ({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config: c }));
    const r = installGuard(createGuard(BASE));
    const stale = proto._request;
    expect(stale).not.toBe(before);
    r();
    expect(proto._request).toBe(before);
    restoreGuard();
    try {
      expect(proto._request.name).not.toMatch(/qboGuard/);
      const bare = new (ax as any).Axios({ adapter: own });
      await expect(stale.call(bare, { url: 'https://other.example.test/s' })).resolves.toMatchObject({ data: 'ok' });
    } finally {
      restoreGuard = installGuard(guard);
    }
    expect(own).toHaveBeenCalledTimes(1);
    expect(net.calls).toHaveLength(0);
  });

  it('TG1: an instance made before install, and a bare context calling _request, are refused transport', async () => {
    restoreGuard();
    const pre = ax.create();
    restoreGuard = installGuard(guard);
    await refusedWith(inCall(() => pre.request({ ...UPLOAD, adapter: 'http' } as any)), 'transport');
    await refusedWith(inCall(() => (pre as any)({ ...UPLOAD, adapter: 'http' })), 'transport');
    await refusedWith(inCall(() => new (ax as any).Axios({})._request({ ...UPLOAD, adapter: 'http' })), 'transport');
    expect(net.calls).toHaveLength(0);
  });

  it("TG6: after restore, create() on an instance made under the guard is axios' own again", async () => {
    const own = jest.fn(async (c: any) => ({ data: 'ok', status: 200, statusText: 'OK', headers: {}, config: c }));
    const made = ax.create();
    restoreGuard();
    try {
      await expect(made.create({ adapter: own as any }).get('https://other.example.test/c')).resolves.toMatchObject({ data: 'ok' });
    } finally {
      restoreGuard = installGuard(guard);
    }
    expect(own).toHaveBeenCalledTimes(1);
  });

  it('TG7: a restore out of order throws and changes nothing; in order, each restores', async () => {
    const g2 = createGuard(BASE);
    const r2 = installGuard(g2);
    expect(() => restoreGuard()).toThrow('qbo-guard: restore out of order');
    expect(ax.defaults.adapter).toBe(g2.adapter);
    await refusedWith(inCall(() => new (ax as any).Axios({}).request({ ...UPLOAD, adapter: 'http' })), 'transport');
    r2();
    expect(ax.defaults.adapter).toBe(guard.adapter);
    createGuard(BASE);
    await inCall(() => ax.get(P));
    expect(net.calls).toHaveLength(1);
  });

  it('TG3: decide and the wire read one snapshot of the headers, whatever toJSON returns', async () => {
    let lists = 0;
    class Shifty extends (ax as any).AxiosHeaders {
      toJSON() {
        const all: Record<string, string> = { Accept: 'application/json', 'X-Api-Key': 'crossed' };
        return new Proxy(all, {
          ownKeys: (target) => (lists++ === 0 ? ['Accept'] : Reflect.ownKeys(target)),
        });
      }
    }
    const t = function (this: any, d: unknown) {
      this.headers = new Shifty();
      return d;
    };
    await inCall(() => ax.get(P, { transformRequest: [t] } as any));
    expect(net.calls).toHaveLength(1);
    expect(Object.keys(net.calls[0].headers ?? {}).map((k) => k.toLowerCase())).not.toContain('x-api-key');
  });

  it('TF4: the headers sent are the ones decide saw, read once', async () => {
    let reads = 0;
    const cfg = Object.defineProperty({ ...ax.defaults, method: 'get', url: P }, 'headers', {
      get: () => (reads++ === 0 ? {} : { 'X-Second': 'v' }),
      enumerable: true,
      configurable: true,
    });
    await inCall(() => guard.adapter(cfg));
    expect(net.calls).toHaveLength(1);
    expect(Object.keys(net.calls[0].headers ?? {}).map((k) => k.toLowerCase())).not.toContain('x-second');
  });

  it("TF5: create() passes the caller's instance config through", () => {
    expect(ax.create({ timeout: 4321 }).defaults.timeout).toBe(4321);
    expect(ax.create({ timeout: 4321 }).create({ timeout: 1234 }).defaults.timeout).toBe(1234);
  });

  it('TF6: a refused http: URL is printed with its scheme, host and path', async () => {
    await expect(inCall(() => ax.get(`http://quickbooks.api.intuit.com/v3/company/${REALM}/preferences`))).rejects.toBeInstanceOf(GuardRefusedError);
    expect(stderr).toHaveLength(1);
    expect(stderr[0].startsWith(`qbo-guard: refused GET http://quickbooks.api.intuit.com/v3/company/${REALM}/preferences (`)).toBe(true);
  });
});
