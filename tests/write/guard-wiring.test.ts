// Sanctuary Computer (quickbooks-mcp-293): write mode's rules through the real adapter, backstop and call store, against the stub network
// over the socket trap (A2.1, A2.16, A3.2-A3.4, A3.9), and the by-id fetch (SB7).
import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import http from 'http';
import https from 'https';
import { fileURLToPath } from 'url';
import { trapNetwork } from '../fakes/no-network.js';
import { installStubNetwork, type StubAnswer, type StubCall } from '../fakes/stub-network.js';
import { stacksFake, type StacksFakeOpts } from '../fakes/stacks-token.js';
import { fixtureToken, NOW, QBO_HOST, REALMS, STACKS_KEY, testEnv } from '../helpers/server.js';
import { configureGuard, createGuard, defaultCallScope, guardedAxios, secureStart, type ExtraRules } from '../../src/http-guard.js';
import { currentCall, currentRealmAllows, currentRecord, runInCall, setCallToken } from '../../src/clients/call-context.js';
import { loadConfig } from '../../src/clients/config.js';
import { createRuntime, type Runtime } from '../../src/clients/runtime.js';
import { byIdUrl, fetchById, fetchPreferences, MINOR_VERSION, updateUrl } from '../../src/write/client.js';
import { decideWrite } from '../../src/write/guard-rules.js';
import { StubRegistry } from './stub-registry.js';

const CASE = JSON.parse(readFileSync(fileURLToPath(new URL('../fakes/transactions/cases/account-and-class.json', import.meta.url)), 'utf8'));
// Non-ASCII text, so a re-encoded body is not the same bytes.
const SPARSE = { ...CASE.sparse_body, PrivateNote: 'café — 日本 🙂  ' } as Record<string, unknown>;
const B = JSON.stringify(SPARSE, null, 1);
const without = (...keys: string[]) => JSON.stringify(Object.fromEntries(Object.entries(SPARSE).filter(([k]) => !keys.includes(k))));
const withField = (key: string, value: unknown) => JSON.stringify({ ...SPARSE, [key]: value });

const COMPANY = 'garden3d';
const REALM = REALMS[COMPANY];
const ROOT = `https://${QBO_HOST}/v3/company/${REALM}`;
const QUERY = 'operation=update&minorversion=75';
const UPDATE = `${ROOT}/purchase?${QUERY}`;
const BY_ID = `${ROOT}/purchase/5?minorversion=75`;

const trap = trapNetwork();
let stacksOpts: StacksFakeOpts = {};
let stacks = stacksFake();
let answer: (call: StubCall) => StubAnswer | Promise<StubAnswer> = () => ({ status: 200 });
const net = installStubNetwork((call) => (call.hostname === QBO_HOST ? answer(call) : stacks.handler(call)));
const ax = guardedAxios();

let registry = new StubRegistry();
let seen: unknown[][] = [];
const rules: ExtraRules = {
  decide(request, context) {
    seen.push([request, context]);
    return decideWrite(request, context, { company: () => currentCall()?.company, registry });
  },
};

let runtime: Runtime;
let restoreStart: () => void;
/** Write mode's start, with the given rules; read mode's with none. */
function start(extraRules: ExtraRules | undefined = rules): void {
  restoreStart = secureStart(testEnv() as NodeJS.ProcessEnv, [], { extraRules });
  runtime = createRuntime(loadConfig(testEnv()), { now: () => NOW });
}
function stop(): void {
  runtime.close();
  restoreStart();
}
function startReadMode(): void {
  stop();
  restoreStart = secureStart(testEnv() as NodeJS.ProcessEnv, []);
  runtime = createRuntime(loadConfig(testEnv()), { now: () => NOW });
}

beforeEach(() => {
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stacksOpts = {};
  stacks = stacksFake(stacksOpts);
  answer = () => ({ status: 200 });
  registry = new StubRegistry().hold(COMPANY, 'purchase', B);
  seen = [];
  start();
  net.calls.length = 0;
});
afterEach(() => {
  stop();
  jest.restoreAllMocks();
  expect(trap.reached).toEqual([]);
});
afterAll(() => {
  net.restore();
  trap.restore();
});

const qboCalls = () => net.calls.filter((c) => c.hostname === QBO_HOST);
/** Runs `fn` as a tool call holding the company's fake token, fetched from the Stacks fake. */
const inCall = <T>(fn: () => Promise<T>, company = COMPANY): Promise<T> =>
  runInCall(company, async () => {
    const got = await runtime.stacks.get(company);
    if (!got.ok) throw new Error('no token');
    setCallToken(got.token.access_token, got.token.realm_id);
    return fn();
  });
/** The same with no Stacks fetch, for a test whose stand-ins would refuse that too. */
const inCallHeld = <T>(fn: () => Promise<T>): Promise<T> =>
  runInCall(COMPANY, () => {
    setCallToken(fixtureToken(COMPANY), REALM);
    return fn();
  });
const send = (over: Record<string, unknown> = {}) =>
  ax.request({ method: 'post', url: UPDATE, data: B, transformRequest: [(d: unknown) => d], headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, ...over } as any);
const get = (path: string, over: Record<string, unknown> = {}) => ax.request({ method: 'get', url: ROOT + path, ...over } as any);

/** Refused with the rule, nothing at the stub, the capability still held, then used by the valid update. */
async function refusedUnconsumed(request: () => Promise<unknown>, rule?: string, opts: { holds?: boolean } = {}): Promise<void> {
  const size = registry.size;
  await inCallHeld(async () => {
    const before = net.calls.length;
    await expect(request()).rejects.toMatchObject(rule === undefined ? { name: 'GuardRefusedError' } : { name: 'GuardRefusedError', rule });
    expect(net.calls).toHaveLength(before);
    expect(trap.reached).toEqual([]);
  });
  expect(registry.takes.filter((t) => t.taken)).toEqual([]);
  expect(registry.size).toBe(size);
  if (opts.holds === false) return;
  registry.hold(COMPANY, 'purchase', B);
  expect((await inCall(() => send())).status).toBe(200);
  expect(registry.takes.at(-1)).toMatchObject({ entity: 'purchase', taken: true });
}

describe('the by-id fetch', () => {
  it('one minor version, on both URLs (A2.16)', () => {
    expect(MINOR_VERSION).toBe('75');
    expect(byIdUrl('7', 'class', '12')).toBe('https://quickbooks.api.intuit.com/v3/company/7/class/12?minorversion=75');
    expect(updateUrl('7', 'bill')).toBe('https://quickbooks.api.intuit.com/v3/company/7/bill?operation=update&minorversion=75');
    expect(updateUrl(REALM, 'purchase')).toBe(UPDATE);
  });

  it.each(['purchase', 'bill', 'account', 'class'] as const)('%s reaches the stub, with the call\'s own token', async (entity) => {
    answer = () => ({ status: 200, body: '{"x":[1]}' });
    expect(await inCall(() => fetchById(entity, '5'))).toEqual({ status: 200, data: { x: [1] } });
    expect(qboCalls()).toHaveLength(1);
    const [call] = qboCalls();
    expect(call).toMatchObject({ method: 'GET', path: `/v3/company/${REALM}/${entity}/5?minorversion=75`, body: '' });
    expect(call.headers).toMatchObject({ Authorization: `Bearer ${fixtureToken(COMPANY)}`, Accept: 'application/json' });
  });

  it('fetchPreferences reaches the stub, by 291\'s rule', async () => {
    expect(await inCall(() => fetchPreferences())).toEqual({ status: 200, data: {} });
    expect(qboCalls().map((c) => [c.method, c.path, c.headers?.Authorization, c.headers?.Accept])).toEqual([
      ['GET', `/v3/company/${REALM}/preferences?minorversion=75`, `Bearer ${fixtureToken(COMPANY)}`, 'application/json'],
    ]);
  });

  it('nothing is cached: two fetches, two requests', async () => {
    await inCall(async () => {
      await fetchById('account', '5');
      await fetchById('account', '5');
      await fetchPreferences();
      await fetchPreferences();
    });
    expect(qboCalls()).toHaveLength(4);
  });

  it('a 401 refetches the token from Stacks and resends once; a second 401 is the answer', async () => {
    const statuses = [401, 200, 401, 401];
    answer = () => ({ status: statuses.shift() as number, body: '{"n":1}' });
    expect(await inCall(() => fetchById('bill', '5'))).toEqual({ status: 200, data: { n: 1 } });
    expect([qboCalls().length, stacks.requests.length]).toEqual([2, 2]);
    net.calls.length = 0;
    expect(await inCall(() => fetchById('bill', '5'))).toEqual({ status: 401, data: { n: 1 } });
    expect([qboCalls().length, stacks.requests.length]).toEqual([2, 3]);
  });

  it('the resend, and the next fetch in the call, carry the new token', async () => {
    const other = ['a', 'newer', 'token'].join('-');
    await inCall(async () => {
      stacksOpts.sequence = [{ status: 200, body: { access_token: other, realm_id: REALM, expires_at: '2026-11-18T12:00:00Z', company_name: 'garden3d, LLC', enterprise: COMPANY } }];
      const statuses = [401, 200, 200];
      answer = () => ({ status: statuses.shift() as number });
      setCallToken(fixtureToken('earlier'), REALM);
      await fetchById('bill', '5');
      expect(currentCall()?.token).not.toBe(fixtureToken('earlier'));
      await fetchById('bill', '6');
    });
    const sent = qboCalls().map((c) => c.headers?.Authorization);
    expect(sent[0]).toBe(`Bearer ${fixtureToken('earlier')}`);
    expect(sent[1]).not.toBe(sent[0]);
    expect(sent[2]).toBe(sent[1]);
  });

  it('a 429 resends once, then the answer is returned', async () => {
    answer = () => ({ status: 429, headers: { 'Retry-After': '0' }, body: '{"n":2}' });
    expect(await inCall(() => fetchById('class', '5'))).toEqual({ status: 429, data: { n: 2 } });
    expect([qboCalls().length, stacks.requests.length]).toEqual([2, 1]);
  });

  it('any other answer is returned as it came', async () => {
    for (const status of [400, 404, 500]) {
      answer = () => ({ status, body: '{"Fault":{}}' });
      expect(await inCall(() => fetchById('purchase', '5'))).toEqual({ status, data: { Fault: {} } });
      expect(await inCall(() => fetchPreferences())).toEqual({ status, data: { Fault: {} } });
    }
  });

  it('a refusal and a failed connection reject', async () => {
    await expect(inCall(() => fetchById('vendor' as any, '5'))).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'entity-by-id' });
    await expect(inCall(() => fetchById('purchase', '5x'))).rejects.toMatchObject({ name: 'GuardRefusedError' });
    expect(qboCalls()).toHaveLength(0);
    answer = () => Promise.reject(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    await expect(inCall(() => fetchById('purchase', '5'))).rejects.toMatchObject({ code: 'ECONNRESET' });
  });

  it('outside a call, with no token, or with no realm: it throws and sends nothing, and the guard is not asked', async () => {
    const none = new Error('write client: no call with a token');
    await expect(fetchById('purchase', '5')).rejects.toEqual(none);
    await expect(fetchPreferences()).rejects.toEqual(none);
    await expect(runInCall(COMPANY, () => fetchById('purchase', '5'))).rejects.toEqual(none);
    const onlyOne = (key: 'token' | 'realm') =>
      runInCall(COMPANY, () => {
        currentCall()![key] = key === 'token' ? fixtureToken(COMPANY) : REALM;
        return fetchById('purchase', '5');
      });
    await expect(onlyOne('token')).rejects.toEqual(none);
    await expect(onlyOne('realm')).rejects.toEqual(none);
    expect(net.calls).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it('two companies\' overlapping calls each send their own token, to their own realm', async () => {
    let arrived = 0;
    let release: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    answer = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await both;
      return { status: 200 };
    };
    const names = [COMPANY, 'index-space'];
    await Promise.all(names.map((name) => inCall(() => fetchById('account', '5'), name)));
    expect(Object.fromEntries(qboCalls().map((c) => [c.path, c.headers?.Authorization]))).toEqual(
      Object.fromEntries(names.map((name) => [`/v3/company/${REALMS[name]}/account/5?minorversion=75`, `Bearer ${fixtureToken(name)}`])),
    );
  });
});

describe('the allowed update', () => {
  it('reaches the stub once, its body byte for byte, the capability consumed before it leaves; a second is refused', async () => {
    const held: number[] = [];
    answer = () => {
      held.push(registry.size);
      return { status: 200 };
    };
    await inCall(async () => {
      expect((await send()).status).toBe(200);
      await expect(send()).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'write-update' });
    });
    expect(held).toEqual([0]);
    expect(qboCalls()).toHaveLength(1);
    const [call] = qboCalls();
    expect(call).toMatchObject({ module: 'https', method: 'POST', path: `/v3/company/${REALM}/purchase?${QUERY}` });
    expect(call.body).toBe(B);
    expect(call.headers).toMatchObject({ 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': String(Buffer.byteLength(B)) });
    expect(registry.takes).toHaveLength(2);
  });

  it('to bill, and in the other key order', async () => {
    registry.hold(COMPANY, 'bill', B);
    const url = `${ROOT}/bill?minorversion=75&operation=update`;
    await inCall(() => send({ url, params: null }));
    expect(qboCalls().map((c) => [c.path, c.body])).toEqual([[`/v3/company/${REALM}/bill?minorversion=75&operation=update`, B]]);
  });

  it('what is decided is what is sent: each field read once by the adapter', async () => {
    // Not enumerable, so getUri's merge (which reads every enumerable key) reads none of these: each read is the adapter's own.
    const once = (url: string, values: Record<string, [unknown, unknown]>) => {
      const reads: Record<string, number> = {};
      const config: Record<string, unknown> = { url, headers: {} };
      for (const [key, [first, later]] of Object.entries(values)) {
        Object.defineProperty(config, key, { get: () => ((reads[key] = (reads[key] ?? 0) + 1) === 1 ? first : later) });
      }
      return { reads, config };
    };
    const update = once(UPDATE, { method: ['POST', 'PUT'], data: [B, 'other'], responseType: ['json', 'stream'] });
    const kept = once(`${ROOT}/preferences?minorversion=75`, { method: ['GET', 'POST'], data: [undefined, 'other'], responseType: ['json', 'stream'] });
    await inCall(async () => {
      await (ax.defaults.adapter as any)(update.config);
      await (ax.defaults.adapter as any)(kept.config);
    });
    for (const { reads } of [update, kept]) expect(reads).toEqual({ method: 1, data: 1, responseType: 1 });
    expect(qboCalls().map((c) => [c.method, c.body])).toEqual([['POST', B], ['GET', '']]);
  });

  it('the rules get the one request the adapter read, and the guard\'s context', async () => {
    await inCall(() => send({ headers: { Accept: 'a/b', 'Content-Type': 'application/json' } }));
    const [[request, context]] = seen.slice(-1) as any;
    expect(request).toMatchObject({ method: 'post', url: UPDATE, params: undefined, data: B, headers: { Accept: 'a/b' } });
    expect(Object.getPrototypeOf(request.headers)).toBe(Object.prototype);
    expect(context.stacksUrl).toBe('https://stacks.example.test');
    expect(context.callRecord).toBe(currentRecord);
  });

  it('a refused answer to it is not resent, and redirects are not followed', async () => {
    for (const status of [401, 429, 302]) {
      registry.hold(COMPANY, 'purchase', B);
      net.calls.length = 0;
      answer = () => ({ status, headers: { location: UPDATE } });
      await expect(inCall(() => send())).rejects.toMatchObject({ response: { status } });
      expect(qboCalls()).toHaveLength(1);
    }
  });
});

/** Each A3.2 case that holds its own capability names the body. */
type Case = [name: string, over: Record<string, unknown>, body?: string];
const at = (url: string): Record<string, unknown> => ({ url });
const A32: Case[] = [
  ['(a) to bill', at(`${ROOT}/bill?${QUERY}`)],
  ['(b) delete', at(`${ROOT}/purchase?operation=delete&minorversion=75`)],
  ['(c) no sparse', { data: without('sparse') }, without('sparse')],
  ['(d) sparse false', { data: withField('sparse', false) }, withField('sparse', false)],
  ['(e) another realm', at(UPDATE.replace(REALM, REALMS['index-space']))],
  ['(f) format=json', at(`${UPDATE}&format=json`)],
  ['(g) minorversion alone', at(`${ROOT}/purchase?minorversion=75`)],
  ['(h) an id', at(`${ROOT}/purchase/123?${QUERY}`)],
  ['(i) PUT', { method: 'put' }],
  ['(i) PATCH', { method: 'patch' }],
  ['(j) no Id', { data: without('Id') }, without('Id')],
  ['(j) no SyncToken', { data: without('SyncToken') }, without('SyncToken')],
  ['(k) update then delete', at(`${ROOT}/purchase?operation=update&operation=delete&minorversion=75`)],
  ['(k) delete then update', at(`${ROOT}/purchase?operation=delete&operation=update&minorversion=75`)],
  ['(l) two minorversions', at(`${UPDATE}&minorversion=74`)],
  ['(m) params', { params: { operation: 'delete' } }],
  ['(m) empty params', { params: {} }],
  ['(n) a re-cased key', at(`${ROOT}/purchase?Operation=update&minorversion=75`)],
  ['(o) an encoded value', at(`${ROOT}/purchase?operation=%75pdate&minorversion=75`)],
  ['(p) a trailing slash', at(`${ROOT}/purchase/?${QUERY}`)],
  ['(p) a capital', at(`${ROOT}/Purchase?${QUERY}`)],
  ['(p) an encoded letter', at(`${ROOT}/%70urchase?${QUERY}`)],
  ['(q) minorversion 76', at(`${ROOT}/purchase?operation=update&minorversion=76`)],
  ['(r) the sandbox', at(UPDATE.replace(QBO_HOST, `sandbox-${QBO_HOST}`))],
  ['(s) another host', at(UPDATE.replace(QBO_HOST, 'evil.example.test'))],
  ['(t) http', at(UPDATE.replace('https:', 'http:'))],
  ['(u) :443', at(UPDATE.replace(QBO_HOST, `${QBO_HOST}:443`))],
  ['(u) :8443', at(UPDATE.replace(QBO_HOST, `${QBO_HOST}:8443`))],
  ['(v) userinfo', at(UPDATE.replace(QBO_HOST, `u:p@${QBO_HOST}`))],
  ['(w) X-Api-Key', { headers: { 'X-Api-Key': STACKS_KEY } }],
  ['(w) x-api-key', { headers: { 'x-api-key': STACKS_KEY } }],
  ['SB3 dot segments', at(`${ROOT}/x/../purchase?${QUERY}`)],
  ['SB3 %2e%2e', at(`${ROOT}/x/%2e%2e/purchase?${QUERY}`)],
];

describe('A3.2 through the adapter: sends nothing, consumes nothing (A3.4)', () => {
  it.each(A32.map(([name, over, body]) => ({ name, over, body })))('$name', async ({ over, body }) => {
    if (body !== undefined) registry = new StubRegistry().hold(COMPANY, 'purchase', body);
    await refusedUnconsumed(() => send(over));
  });

  // Each of these passes decideWrite, so only the adapter's own check, run before it, keeps the capability.
  it('a baseURL that moves the request', async () => {
    const over = { baseURL: 'https://evil.example.test', allowAbsoluteUrls: false };
    await refusedUnconsumed(() => send(over), 'guard-error');
    registry = new StubRegistry().hold(COMPANY, 'purchase', B);
    const defaults = ax.defaults as any;
    Object.assign(defaults, over);
    try {
      await refusedUnconsumed(() => send(), 'guard-error', { holds: false });
    } finally {
      delete defaults.baseURL;
      delete defaults.allowAbsoluteUrls;
    }
  });

  it('a getUri that throws', async () => {
    const spy = jest.spyOn(ax, 'getUri').mockImplementation(() => {
      throw new Error('getUri');
    });
    await refusedUnconsumed(() => send(), 'guard-error', { holds: false });
    spy.mockRestore();
    expect((await inCall(() => send())).status).toBe(200);
  });

  it('an http adapter that can\'t be resolved', async () => {
    const spy = jest.spyOn(ax, 'getAdapter').mockImplementation(() => {
      throw new Error('no adapter');
    });
    await refusedUnconsumed(() => send(), 'guard-error', { holds: false });
    spy.mockRestore();
    expect((await inCall(() => send())).status).toBe(200);
  });

  it('a kept field that throws when read', async () => {
    const config = Object.defineProperty({ method: 'post', url: UPDATE, data: B, headers: {} }, 'timeout', {
      get: () => {
        throw new Error('timeout');
      },
    });
    await refusedUnconsumed(() => (ax.defaults.adapter as any)(config), 'guard-error');
  });

  it.each(['Host', 'host', 'HOST', ' Host '])('a %j header, which the backstop would refuse later', async (name) => {
    // Straight to the adapter: axios trims a name on some paths to it and not on others, and always on the way to the wire.
    await refusedUnconsumed(() => (ax.defaults.adapter as any)({ method: 'post', url: UPDATE, data: B, headers: { [name]: 'evil.example.test' } }), 'guard-error', { holds: false });
    await refusedUnconsumed(() => send({ headers: { [name]: 'evil.example.test' } }), 'guard-error');
  });

  it('getUri, the adapter and the fields are not asked again once the rules have allowed it', async () => {
    const after: string[] = [];
    let decided = false;
    const uri = ax.getUri.bind(ax);
    const adapter = ax.getAdapter.bind(ax);
    jest.spyOn(ax, 'getUri').mockImplementation((c) => (decided && after.push('getUri'), uri(c)));
    jest.spyOn(ax, 'getAdapter').mockImplementation((a) => (decided && after.push('getAdapter'), adapter(a)));
    const decide = rules.decide;
    stop();
    start({ decide: (r, c) => { const own = decide(r, c); decided = r.method === 'post'; return own; } });
    await inCall(() => send());
    expect(decided).toBe(true);
    expect(after).toEqual([]);
  });
});

// TD1, TD2: each would be framed, encoded or refused by axios or Node after the capability is consumed, so it is refused before the rules are asked.
describe('what an update may carry', () => {
  const JSON_TYPE = { 'Content-Type': 'application/json' };
  const viaPost = (config: Record<string, unknown>): Promise<any> => ax.post(UPDATE, B, config as any);
  const direct = (config: Record<string, unknown>): Promise<any> => (ax.defaults.adapter as any)({ method: 'post', url: UPDATE, data: B, ...config });
  const WAYS = { 'axios.post': viaPost, 'the adapter': direct };
  type Way = keyof typeof WAYS;
  const bothWays = <T>(rows: T[]): Array<{ way: Way; row: T }> => rows.flatMap((row) => (Object.keys(WAYS) as Way[]).map((way) => ({ way, row })));

  /** Refused before the rules are asked, nothing sent, nothing taken; then `good`, by the same way, is allowed on that same capability. */
  async function refusedBeforeRules(way: Way, bad: Record<string, unknown>, good: Record<string, unknown> = { headers: JSON_TYPE }): Promise<void> {
    net.calls.length = 0;
    await inCallHeld(async () => {
      await expect(WAYS[way](bad)).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'guard-error' });
      expect([net.calls.length, seen.length, registry.takes.length, registry.size]).toEqual([0, 0, 0, 1]);
      expect((await WAYS[way](good)).status).toBe(200);
    });
    expect(registry.takes.map((t) => t.taken)).toEqual([true]);
    expect(net.calls.map((c) => c.body)).toEqual([B]);
  }

  const HEADERS: Array<[string, string]> = [
    ['Content-Length', '5'],
    ['Content-Length', '99999'],
    ['content-length', '5'],
    ['Transfer-Encoding', 'chunked'],
    ['Transfer-Encoding', 'gzip'],
    ['Expect', '100-continue'],
    ['Connection', 'close'],
    ['Connection', 'Upgrade'],
    ['Upgrade', 'websocket'],
    ['Keep-Alive', 'timeout=5'],
    ['Trailer', 'X-T'],
    ['TE', 'trailers'],
    ['Content-Encoding', 'gzip'],
    ['Content-MD5', 'x'],
    ['X-HTTP-Method-Override', 'DELETE'],
    ['bad name', 'x'],
    ['x(y)', 'x'],
    ['naïve', 'x'],
    ['User-Agent', 'x'],
    ['Cookie', 'x'],
    ['Accept-Encoding', 'identity'],
    ['Acceptx', 'x'],
    ['X-Accept', 'x'],
  ];
  it.each(bothWays(HEADERS))('$row is refused through $way', async ({ way, row: [name, value] }) => {
    await refusedBeforeRules(way, { headers: { ...JSON_TYPE, [name]: value } });
  });

  it.each([' Accept ', 'Accept '])('a name that only trimming makes one of the three is refused: %j', async (name) => {
    await refusedBeforeRules('the adapter', { headers: { [name]: 'x' } });
  });

  const TYPES = ['application/x-www-form-urlencoded', 'application/json; charset=utf-8', 'application/json;charset=utf-8', 'Application/JSON', 'text/plain', ''];
  it.each(bothWays(TYPES))('Content-Type $row is refused through $way', async ({ way, row }) => {
    await refusedBeforeRules(way, { headers: { 'content-type': row } });
  });

  it('a string body with no Content-Type goes as a form by axios.post, so it is refused there; straight to the adapter there is none to check', async () => {
    await refusedBeforeRules('axios.post', {});
    registry.hold(COMPANY, 'purchase', B);
    await inCallHeld(() => direct({ headers: {} }));
    expect(net.calls.at(-1)?.body).toBe(B);
  });

  it.each(bothWays([['AUTHORIZATION', 'CONTENT-TYPE', 'ACCEPT'], ['authorization', 'content-type', 'accept'], ['Authorization', 'Content-Type', 'Accept']]))('$row are sent through $way', async ({ way, row }) => {
    const values = ['Bearer x', 'application/json', 'application/json'];
    await inCallHeld(() => WAYS[way]({ headers: Object.fromEntries(row.map((name, i) => [name, values[i]])) }));
    const sent = Object.fromEntries(Object.entries(net.calls.at(-1)!.headers!).map(([k, v]) => [k.toLowerCase(), v]));
    expect(sent).toMatchObject({ authorization: 'Bearer x', 'content-type': 'application/json', accept: 'application/json', 'content-length': String(Buffer.byteLength(B)) });
    expect(Object.keys(sent).sort()).toEqual(['accept', 'accept-encoding', 'authorization', 'content-length', 'content-type', 'user-agent']);
    expect(registry.size).toBe(0);
  });

  // Set on axios' own header object, past the cleaning its `set` does.
  it.each([
    ['a list', ['a', 'b']],
    ['an empty list', []],
    ['a number', 5],
    ['true', true],
    ['an object', { toString: () => 'x' }],
    ['a line feed', 'a\nX-B: c'],
    ['a carriage return', 'a\r'],
    ['a NUL', 'a\0'],
    ['a DEL', 'a\x7f'],
    ['a Latin-1 letter', 'é'],
    ['a letter outside Latin-1', '日'],
  ])('a header value of %s is refused', async (_name, value) => {
    const headers = Object.assign(new ax.AxiosHeaders(), { Accept: value });
    await refusedBeforeRules('the adapter', { headers });
  });

  it('a tab and every printable ASCII character in a value are sent', async () => {
    await inCallHeld(() => direct({ headers: { Authorization: 'a\t !~' } }));
    expect(net.calls.at(-1)?.headers?.Authorization).toBe('a\t !~');
  });

  const BAD_TIMEOUTS = ['abc', '', '5', -1, 1.5, NaN, Infinity, 2147483648, null, true, [5], { connect: 1 }, 5n];
  it.each(bothWays(BAD_TIMEOUTS.map((value) => [value])))('a timeout of $row is refused through $way', async ({ way, row: [timeout] }) => {
    await refusedBeforeRules(way, { headers: JSON_TYPE, timeout }, { headers: JSON_TYPE, timeout: 5 });
  });

  it.each(bothWays([undefined, 0, 1, 2147483647].map((value) => [value])))('a timeout of $row is sent through $way', async ({ way, row: [timeout] }) => {
    expect((await inCallHeld(() => WAYS[way]({ headers: JSON_TYPE, timeout }))).status).toBe(200);
  });

  it('the timeout sent is the one checked', async () => {
    const sent: unknown[] = [];
    const real = ax.getAdapter('http');
    jest.spyOn(ax, 'getAdapter').mockReturnValue(((c: any) => (sent.push(c.timeout), (real as any)(c))) as any);
    let reads = 0;
    const config = Object.defineProperty({ method: 'post', url: UPDATE, data: B, headers: {} }, 'timeout', { get: () => ((reads += 1) === 1 ? 7 : 'abc') });
    await inCallHeld(() => (ax.defaults.adapter as any)(config));
    expect(sent).toEqual([7]);
  });

  it('a GET keeps its other headers and its timeout, in any case of GET; a method that is no string is not one', async () => {
    const config = { url: BY_ID, headers: { 'User-Agent': 'x', 'Content-Type': 'text/plain' }, timeout: '5' };
    await inCallHeld(async () => {
      for (const method of ['get', 'GET']) await (ax.defaults.adapter as any)({ ...config, method });
      expect(net.calls.map((c) => c.headers?.['User-Agent'])).toEqual(['x', 'x']);
      const asked = seen.length;
      for (const method of [['GET'], 'GETS', 'XGET', ' get', 'get ', 'GET\t', undefined]) {
        await expect((ax.defaults.adapter as any)({ ...config, method })).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'guard-error' });
      }
      expect(seen.length).toBe(asked);
    });
  });

  it('a Host header on a GET is refused before the rules too', async () => {
    for (const name of ['Host', ' hOST ']) {
      await inCallHeld(() => expect((ax.defaults.adapter as any)({ method: 'get', url: BY_ID, headers: { [name]: 'x' } })).rejects.toMatchObject({ rule: 'guard-error' }));
    }
    expect([net.calls.length, seen.length]).toEqual([0, 0]);
  });
});

describe('A3.3 through the adapter', () => {
  it('(a) a replay', async () => {
    await inCall(() => send());
    net.calls.length = 0;
    await expect(inCall(() => send())).rejects.toMatchObject({ rule: 'write-update' });
    expect(net.calls).toHaveLength(0);
  });

  it('(b) one byte changed', () => refusedUnconsumed(() => send({ data: B.replace('café', 'cafe') }), 'write-update'));

  it('(c) another company\'s capability', async () => {
    registry = new StubRegistry().hold('index-space', 'purchase', B);
    await refusedUnconsumed(() => send(), 'write-update');
  });

  it('(e) a create', async () => {
    const body = without('Id', 'SyncToken');
    registry = new StubRegistry().hold(COMPANY, 'purchase', body);
    await refusedUnconsumed(() => send({ url: `${ROOT}/purchase?minorversion=75`, data: body }), 'write-update');
  });

  it('(f) /batch', async () => {
    registry.hold(COMPANY, 'batch', B);
    await refusedUnconsumed(() => send({ url: `${ROOT}/batch?${QUERY}` }), 'write-update');
  });

  it('(g) outside a call', async () => {
    await expect(send()).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'write-update' });
    expect(net.calls).toHaveLength(0);
    expect(registry.size).toBe(1);
  });
});

describe('A3.9 through the adapter', () => {
  const REFUSED: Array<[string, () => Promise<unknown>]> = [
    ['vendor', () => get('/vendor/5?minorversion=75')],
    ['invoice', () => get('/invoice/5?minorversion=75')],
    ['a word id', () => get('/purchase/abc?minorversion=75')],
    ['a further segment', () => get('/purchase/5/x?minorversion=75')],
    ['a capital', () => get('/Purchase/5?minorversion=75')],
    ['another key', () => get('/purchase/5?minorversion=75&operation=delete')],
    ['minorversion 74 (A2.16)', () => get('/purchase/5?minorversion=74')],
    ['21 digits', () => get('/purchase/123456789012345678901?minorversion=75')],
    ['minorversion in params', () => get('/purchase/5', { params: { minorversion: '75' } })],
    ['another realm', () => ax.get(BY_ID.replace(REALM, REALMS['index-space']))],
    ['the sandbox', () => ax.get(BY_ID.replace(QBO_HOST, `sandbox-${QBO_HOST}`))],
    ['another host', () => ax.get(BY_ID.replace(QBO_HOST, 'evil.example.test'))],
    ['http', () => ax.get(BY_ID.replace('https:', 'http:'))],
    ['a port', () => ax.get(BY_ID.replace(QBO_HOST, `${QBO_HOST}:443`))],
    ['userinfo', () => ax.get(BY_ID.replace(QBO_HOST, `u:p@${QBO_HOST}`))],
    ['X-Api-Key', () => get('/purchase/5?minorversion=75', { headers: { 'X-Api-Key': STACKS_KEY } })],
    ['a body', () => get('/purchase/5?minorversion=75', { data: '{}' })],
    ['a report', () => get('/reports/ProfitAndLoss?minorversion=75')],
    ['a report by params', () => get('/reports/ProfitAndLoss', { params: { minorversion: '75' } })],
    ['a baseURL that moves it', () => get('/purchase/5?minorversion=75', { baseURL: 'https://evil.example.test', allowAbsoluteUrls: false })],
  ];
  it.each(REFUSED)('refused: %s', (_name, request) => refusedUnconsumed(request));

  it('refused outside a call', async () => {
    await expect(ax.get(BY_ID)).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'entity-by-id-write' });
    expect(net.calls).toHaveLength(0);
  });

  it('291\'s rules still answer the rest: params and all, getUri checked, the query recorded', async () => {
    await inCall(async () => {
      await get('/preferences', { params: { minorversion: '75', format: 'json' } });
      await get('/query?query=select * from Purchase maxresults 1&minorversion=75');
      expect(currentRecord()?.queries).toMatchObject([{ entity: 'purchase', status: 200 }]);
      await expect(get('/preferences', { params: { minorversion: '75' }, paramsSerializer: () => 'minorversion=75&x=1' })).rejects.toMatchObject({ rule: 'guard-error' });
      await expect(get('/query?query=select * from Purchase maxresults 1&minorversion=75')).rejects.toMatchObject({ rule: 'query' });
    });
    expect(qboCalls().map((c) => c.path)).toEqual([
      `/v3/company/${REALM}/preferences?minorversion=75&format=json`,
      `/v3/company/${REALM}/query?query=select%20*%20from%20Purchase%20maxresults%201&minorversion=75`,
    ]);
    // The Stacks hand-out too, by inCall.
    expect(stacks.requests).toHaveLength(1);
  });
});

describe('the URL sent is the one the adapter read (TD3)', () => {
  it.each([['post', UPDATE, B, 'write-update'], ['get', BY_ID, undefined, 'entity-by-id-write']])('%s, whatever URL the rules answer with', async (method, url, data, rule) => {
    const other = `${ROOT}/bill/6?minorversion=75`;
    stop();
    start({ decide: () => ({ allow: true, rule: rule as any, text: other, url: other }) });
    await inCallHeld(() => (ax.defaults.adapter as any)({ method, url, data, headers: {} }));
    expect(net.calls.map((c) => `https://${c.hostname}${c.path}`)).toEqual([url]);
  });
});

describe('data is sent for an allowed write-update only', () => {
  const allowing = (rule: string): ExtraRules => ({ decide: (r) => (r.url === BY_ID ? { allow: true, rule: rule as any, text: BY_ID, url: BY_ID } : { match: false }) });

  it.each([
    ['entity-by-id-write', ''],
    ['write-update', 'kept'],
  ])('%s sends %j', async (rule, body) => {
    stop();
    start(allowing(rule));
    await inCall(() => ax.request({ method: 'get', url: BY_ID, data: 'kept', transformRequest: [(d: unknown) => d] } as any));
    expect(qboCalls().map((c) => c.body)).toEqual([body]);
  });

  it('291\'s allow drops it', async () => {
    const seenData: unknown[] = [];
    const http = ax.getAdapter('http');
    jest.spyOn(ax, 'getAdapter').mockReturnValue(((c: any) => (seenData.push('data' in c), (http as any)(c))) as any);
    await inCall(async () => {
      await get('/preferences?minorversion=75', { data: '' });
      await get('/purchase/5?minorversion=75', { data: '' });
      await send();
    });
    // Stacks' token, preferences, the by-id fetch, the update.
    expect(seenData).toEqual([false, false, false, true]);
  });
});

describe('the extra rules are fixed when the guard is made', () => {
  it('configureGuard({ extraRules }) throws and changes nothing', async () => {
    for (const value of [undefined, { decide: () => ({ match: false }) }]) {
      expect(() => configureGuard({ keys: () => [], extraRules: value } as any)).toThrow(new TypeError('qbo-guard: extraRules are fixed at start'));
    }
    await inCall(() => send());
    expect(qboCalls()).toHaveLength(1);
  });

  it('only an own extraRules throws: a primitive and an inherited one are read as the keys are (TD4)', () => {
    for (const part of [0, '', true, 'keys', Symbol('x'), Object.create({ extraRules: rules, keys: 'not read either' })]) expect(() => configureGuard(part as any)).not.toThrow();
    expect(() => configureGuard(Object.defineProperty({}, 'extraRules', { value: rules }))).toThrow(new TypeError('qbo-guard: extraRules are fixed at start'));
  });

  it('after a legal configureGuard they still decide, with the new callbacks', async () => {
    configureGuard({ keys: () => [COMPANY], allowedRealm: () => false, callRecord: currentRecord });
    await expect(inCall(() => send())).rejects.toMatchObject({ rule: 'write-update' });
    await expect(inCall(() => ax.get(BY_ID))).rejects.toMatchObject({ rule: 'entity-by-id-write' });
    configureGuard({ allowedRealm: currentRealmAllows });
    await inCall(() => send());
    expect(qboCalls()).toHaveLength(1);
  });

  it('replacing the object\'s decide, or adding it to the context, reaches nothing', async () => {
    const mine: ExtraRules = { decide: rules.decide };
    stop();
    start(mine);
    mine.decide = () => {
      throw new Error('replaced');
    };
    await inCall(() => send());
    expect(qboCalls()).toHaveLength(1);
  });

  it('their decide keeps its object', async () => {
    class Rules implements ExtraRules {
      private readonly inner = rules;
      decide(...args: Parameters<ExtraRules['decide']>) {
        return this.inner.decide(...args);
      }
    }
    stop();
    start(new Rules());
    await inCall(() => send());
    expect(qboCalls()).toHaveLength(1);
  });

  it('rules without a decide stop the start, leaving nothing installed', () => {
    stop();
    const request = https.request;
    expect(() => secureStart(testEnv() as NodeJS.ProcessEnv, [], { extraRules: {} as any })).toThrow(new Error('qbo-guard: install failed'));
    expect(https.request).toBe(request);
    expect(() => defaultCallScope()).toThrow(new Error('qbo-guard: not started'));
    start();
  });

  it('rules that throw, or answer nothing, are a refusal', async () => {
    for (const decide of [() => { throw new Error('rules'); }, () => undefined, () => ({}), () => ({ allow: false, rule: 'write-update' })]) {
      stop();
      start({ decide: decide as any });
      await inCallHeld(async () => {
        await expect(get('/preferences?minorversion=75')).rejects.toMatchObject({ name: 'GuardRefusedError' });
      });
    }
    expect(qboCalls()).toHaveLength(0);
  });

  it('an allow of a request with params, which no rule gives, is refused', async () => {
    stop();
    start({ decide: (r) => (r.params === undefined ? { match: false } : { allow: true, rule: 'write-update', text: UPDATE, url: UPDATE }) });
    await inCall(async () => {
      await expect(send({ params: { operation: 'delete' } })).rejects.toMatchObject({ rule: 'guard-error' });
    });
    expect(qboCalls()).toHaveLength(0);
  });
});

describe('A3.4: the backstop has no write hole', () => {
  it('a raw https.request POST and fetch of the valid update, with the capability registered', async () => {
    await inCall(async () => {
      const before = net.calls.length;
      const refused = expect.objectContaining({ name: 'GuardRefusedError', rule: 'backstop' });
      const u = new URL(UPDATE);
      const options = { method: 'POST', hostname: u.hostname, path: u.pathname + u.search };
      expect(() => https.request(UPDATE, { method: 'POST' })).toThrow(refused as any);
      expect(() => https.request(options)).toThrow(refused as any);
      expect(() => http.request(options)).toThrow(refused as any);
      let caught: unknown;
      try {
        await fetch(UPDATE, { method: 'POST', body: B });
      } catch (e) {
        caught = e;
      }
      expect(caught).toEqual(refused);
      expect(net.calls).toHaveLength(before);
    });
    expect([registry.size, registry.takes.length]).toEqual([1, 0]);
  });
});

describe('without the rules (read mode)', () => {
  it('the same update with a live capability, and a by-id GET, are refused; the registry is not asked', async () => {
    startReadMode();
    await inCall(async () => {
      await expect(send()).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'quickbooks' });
      await expect(fetchById('purchase', '5')).rejects.toMatchObject({ name: 'GuardRefusedError', rule: 'entity-by-id' });
      await fetchPreferences();
    });
    expect(qboCalls().map((c) => c.path)).toEqual([`/v3/company/${REALM}/preferences?minorversion=75`]);
    expect([seen, registry.takes, registry.hasCalls, registry.size]).toEqual([[], [], 0, 1]);
  });

  it('a kept field is not read before a refusal, and a report is allowed', async () => {
    startReadMode();
    let reads = 0;
    const config = Object.defineProperty({ method: 'post', url: UPDATE, data: B, headers: { Host: 'x' } }, 'timeout', { get: () => (reads += 1) });
    const uri = jest.spyOn(ax, 'getUri');
    await inCall(async () => {
      uri.mockClear();
      await expect((ax.defaults.adapter as any)(config)).rejects.toMatchObject({ rule: 'quickbooks' });
      expect([reads, uri.mock.calls.length]).toEqual([0, 0]);
      await get('/reports/ProfitAndLoss?minorversion=75');
    });
    expect(qboCalls()).toHaveLength(1);
  });

  it('a guard made beside it with rules leaves the read-mode one without them', async () => {
    startReadMode();
    const read = ax.defaults.adapter;
    const other = createGuard({ stacksUrl: undefined, keys: () => [], allowedRealm: currentRealmAllows, callRecord: currentRecord }, { extraRules: rules });
    expect(ax.defaults.adapter).toBe(read);
    const config = { method: 'post', url: UPDATE, data: B, headers: {} };
    await inCallHeld(async () => {
      await expect((read as any)(config)).rejects.toMatchObject({ rule: 'quickbooks' });
      expect(registry.size).toBe(1);
      await other.adapter(config);
    });
    expect(registry.size).toBe(0);
  });

  it('http-guard.ts takes types only from src/write', () => {
    const text = readFileSync(fileURLToPath(new URL('../../src/http-guard.ts', import.meta.url)), 'utf8');
    expect(text.split('\n').filter((line) => /["'`]\.\/write\//.test(line))).toEqual(['import type { Unmatched, WriteDecision } from "./write/guard-rules.js";']);
  });
});
