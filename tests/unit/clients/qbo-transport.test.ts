// Sanctuary Computer (quickbooks-mcp-286): the QuickBooks request interceptors (spec D2; A4.1-A4.5b, A4.3b, A4.3c, A4.4b,
// and A4.7's interceptor clause). They are installed on 291's guarded instance, which the real Stacks client shares, and
// every guarded request reaches the stub network below the guard. The few cases the guard would refuse before any
// answer (a POST, a look-alike host, a status outside three digits, axios' clarified timeout) use a plain axios
// instance with a scripted adapter, where the client and the guard aren't the point.
import { describe, it as jestIt, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import axios, { AxiosError, type AxiosInstance } from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork, type StubCall, type StubTable } from '../../fakes/stub-network.js';
import { quickbooksFake, type QuickbooksAnswer, type QuickbooksFakeOpts } from '../../fakes/quickbooks.js';
import { stacksFake, type StacksAnswer, type StacksStep } from '../../fakes/stacks-token.js';
import { startTestGuard } from '../../helpers/guard.js';
import { GuardRefusedError, guardedAxios } from '../../../src/http-guard.js';
import { parseCompanies } from '../../../src/clients/companies.js';
import { currentCall, recordFailure, runInCall, setCallToken, type Failure } from '../../../src/clients/call-context.js';
import type { Config } from '../../../src/clients/config.js';
import { createRealmStore, StacksTokenClient, type RealmStore } from '../../../src/clients/stacks-token.js';
import { installQboInterceptors, QBO_LIMIT_MS, type QboTransportDeps } from '../../../src/clients/qbo-transport.js';

/** Every case is registered through this, so the afterAll can tell an unfiltered run (all ran) from a `-t` run. */
let registered = 0;
let ran = 0;
const it = (name: string, fn: () => unknown): void => {
  registered++;
  jestIt(name, fn as () => Promise<void>);
};

// Order matters: the trap, then the stub (so the guard's backstop wraps the stub), then the guard in beforeEach.
const trap = trapNetwork();
let table: StubTable = () => ({ status: 500 });
const net = installStubNetwork((call) => table(call));

const fakes = (name: string) => fileURLToPath(new URL(`../../fakes/${name}`, import.meta.url));
const COMPANIES = parseCompanies(readFileSync(fakes('entities.json'), 'utf8'));
const KEYS = COMPANIES.map((c) => c.key);

const STACKS = 'https://stacks.example.test';
const STACKS_HOST = 'stacks.example.test';
const QBO_HOST = 'quickbooks.api.intuit.com';
const QBO = `https://${QBO_HOST}`;
const LOOKALIKE = `https://${QBO_HOST}.example.test`;
// Built at runtime: no secret-shaped literal sits in this file.
const KEY = ['fake', 'stacks', 'key'].join('-');
const ACCESS_A = ['qbo', 'test', 'access', 'a'].join('-');
const ACCESS_B = ['qbo', 'test', 'access', 'b'].join('-');
const ACCESS_C = ['qbo', 'test', 'access', 'c'].join('-');
const SECRETS = [KEY, ACCESS_A, ACCESS_B, ACCESS_C, ['qbo', 'test', 'own', 'bearer'].join('-')];

const REALM = '9990000000000002';
const REALM_OTHER = '9990000000000009';
const EXPIRES = '2026-11-18T12:00:00Z';
const NOW = Date.parse(EXPIRES) - 50 * 60_000;
const INFO_URL = `${QBO}/v3/company/${REALM}/companyinfo/${REALM}`;
const INFO_PATH = `/v3/company/${REALM}/companyinfo/${REALM}?minorversion=75`;
const QUERY_URL = `${QBO}/v3/company/${REALM}/query`;
const QUERY = 'select * from Account maxresults 10';

const cfg: Config = { stacksUrl: new URL(STACKS), stacksKey: KEY, companies: COMPANIES, mode: 'read' };

function tokenBody(access: string, realm = REALM): StacksAnswer {
  return {
    status: 200,
    headers: { 'cache-control': 'no-store' },
    body: { enterprise: 'garden3d', realm_id: realm, access_token: access, expires_at: EXPIRES, company_name: 'garden3d, LLC' },
  };
}

type Rig = {
  qbo: ReturnType<typeof quickbooksFake>;
  stacks: ReturnType<typeof stacksFake>;
  realms: RealmStore;
  client: StacksTokenClient;
  waits: number[];
  forced: string[];
};

let ejectors: Array<() => void> = [];
/** The stub routes by host: QuickBooks' to the QuickBooks fake, every other to the Stacks fake. */
function rig(
  opts: { qbo?: QuickbooksFakeOpts; stacks?: StacksStep[]; reacquire?: QboTransportDeps['reacquire']; realSleep?: boolean; noInstall?: boolean } = {},
): Rig {
  const qbo = quickbooksFake(opts.qbo);
  const stacks = stacksFake({ sequence: opts.stacks ?? [tokenBody(ACCESS_A), tokenBody(ACCESS_B), tokenBody(ACCESS_C)] });
  table = (call) => (call.hostname === QBO_HOST ? qbo.handler(call) : stacks.handler(call));
  const realms = createRealmStore();
  const client = new StacksTokenClient(cfg, realms, { now: () => NOW });
  const waits: number[] = [];
  const forced: string[] = [];
  const deps: QboTransportDeps = {
    reacquire:
      opts.reacquire ??
      ((company, sentAt) => {
        forced.push(company);
        return client.get(company, { force: true, sentAt });
      }),
    mark: () => client.mark(),
    secrets: () => [currentCall()?.token, KEY],
  };
  if (!opts.realSleep) {
    deps.sleep = async (ms) => {
      waits.push(ms);
    };
  }
  if (!opts.noInstall) ejectors.push(installQboInterceptors(guardedAxios() as unknown as AxiosInstance, deps).eject);
  return { qbo, stacks, realms, client, waits, forced };
}

const header = (call: StubCall, name: string): unknown => Object.entries(call.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const bearers = (calls: StubCall[]) => calls.map((c) => header(c, 'authorization'));

/** One GET from the call, as node-quickbooks sends it: the call's token in Authorization, minorversion as a param. */
function get(url = INFO_URL, params: Record<string, string> = {}) {
  return guardedAxios()({ method: 'get', url, params: { ...params, minorversion: '75' }, headers: { Authorization: `Bearer ${currentCall()!.token}` } });
}
const getQuery = () => get(QUERY_URL, { query: QUERY });

type Outcome = { ok: boolean; status?: number; error?: unknown; failure: Failure | null };
/** Runs `p` to its end inside the current call and reads the call's recorded failure after it. */
async function settle(p: Promise<{ status: number }>): Promise<Outcome> {
  let o: Omit<Outcome, 'failure'>;
  try {
    o = { ok: true, status: (await p).status };
  } catch (error) {
    o = { ok: false, error };
  }
  const failure = currentCall()!.failure;
  if (failure !== null) seenFailures.push(failure);
  return { ...o, failure };
}

/** Runs `fn` as a garden3d call that already holds a token (a first, unforced Stacks fetch, as the client's first use does). */
function inCall<T>(r: Rig, fn: () => Promise<T>): Promise<T> {
  return runInCall('garden3d', async () => {
    const t = await r.client.get('garden3d');
    if (!t.ok) throw new Error('rig: no first token');
    setCallToken(t.token.access_token, t.token.realm_id);
    return fn();
  });
}

const a = (status: number, headers?: Record<string, string>, body?: unknown): QuickbooksAnswer => ({ status, headers, body });
const OK = a(200, undefined, { CompanyInfo: { CompanyName: 'garden3d, LLC' } });

// ---- a plain instance with a scripted adapter, for the cases the guard would refuse first ----

type Step = { status: number; headers?: Record<string, string>; data?: unknown } | { throws: unknown };
function scripted(steps: Step[]): { ax: AxiosInstance; seen: any[] } {
  const seen: any[] = [];
  const ax = axios.create({
    adapter: async (config: any) => {
      seen.push(config);
      const step = steps[Math.min(seen.length - 1, steps.length - 1)];
      if ('throws' in step) {
        const t = step.throws;
        throw typeof t === 'function' ? (t as (c: unknown) => unknown)(config) : t;
      }
      const response = { status: step.status, statusText: String(step.status), headers: step.headers ?? {}, data: step.data ?? {}, config, request: {} };
      if (step.status >= 200 && step.status < 300) return response;
      throw new AxiosError(`status ${step.status}`, 'ERR_BAD_RESPONSE', config, {}, response as any);
    },
  });
  return { ax, seen };
}
function installOn(ax: AxiosInstance, more: Partial<QboTransportDeps> = {}): { waits: number[]; forced: string[]; sentAts: number[] } {
  const waits: number[] = [];
  const forced: string[] = [];
  const sentAts: number[] = [];
  let marks = 100;
  const deps: QboTransportDeps = {
    reacquire: async (company, sentAt) => {
      forced.push(company);
      sentAts.push(sentAt);
      return { ok: true, token: { access_token: ACCESS_B, realm_id: REALM, expires_at: EXPIRES, company_name: 'garden3d, LLC' } };
    },
    secrets: () => [currentCall()?.token, KEY],
    mark: () => ++marks,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...more,
  };
  ejectors.push(installQboInterceptors(ax, deps).eject);
  return { waits, forced, sentAts };
}
/** A call holding token A for REALM, with no Stacks request. */
const plainCall = <T>(fn: () => Promise<T>): Promise<T> =>
  runInCall('garden3d', () => {
    setCallToken(ACCESS_A, REALM);
    return fn();
  });

/** Every recorded failure any case read, and every stderr write: neither may hold a token or the key. */
const seenFailures: Failure[] = [];
let stderr: string[] = [];
let restoreGuard: () => void;
beforeEach(() => {
  stderr = [];
  jest.spyOn(process.stderr, 'write').mockImplementation(((s: unknown) => {
    stderr.push(String(s));
    return true;
  }) as any);
  restoreGuard = startTestGuard({ stacksUrl: STACKS, keys: KEYS });
});
afterEach(() => {
  for (const eject of ejectors.reverse()) eject();
  ejectors = [];
  restoreGuard();
  jest.useRealTimers();
  jest.restoreAllMocks();
  expect(trap.reached).toEqual([]);
  for (const s of stderr) for (const secret of SECRETS) expect(s).not.toContain(secret);
  net.calls.length = 0;
  ran++;
});
// No recorded failure holds a token or the key; the floor applies only when every registered case ran, so a `-t` run passes.
afterAll(() => {
  const text = JSON.stringify(seenFailures);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
  if (ran === registered) {
    expect(seenFailures.length).toBeGreaterThan(40);
    expect(seenFailures.some((f) => f.text !== undefined)).toBe(true);
  }
});

describe('A4.1: 401 then 200', () => {
  it('one more Stacks fetch, forced despite the cached unexpired token; the identical request resent once with the new token; success', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] } });
    const o = await inCall(r, async () => {
      // The first-use token is cached and unexpired: an unforced get would not ask Stacks again.
      expect((await r.client.get('garden3d')).ok).toBe(true);
      expect(r.stacks.requests).toHaveLength(1);
      const out = await settle(get());
      expect(currentCall()!.token).toBe(ACCESS_B);
      expect(currentCall()!.realm).toBe(REALM);
      return out;
    });
    expect(o).toEqual({ ok: true, status: 200, failure: null });
    expect(r.forced).toEqual(['garden3d']);
    expect(r.stacks.requests).toHaveLength(2);
    expect(r.qbo.requests.map((c) => [c.method, c.hostname, c.path])).toEqual([
      ['GET', QBO_HOST, INFO_PATH],
      ['GET', QBO_HOST, INFO_PATH],
    ]);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`]);
    // Only Authorization changed.
    const rest = (c: StubCall) => Object.fromEntries(Object.entries(c.headers ?? {}).filter(([k]) => !/^(authorization|request-id)$/i.test(k)));
    expect(rest(r.qbo.requests[1])).toEqual(rest(r.qbo.requests[0]));
  });

  it('a lower-case authorization header is replaced, not doubled', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] } });
    await inCall(r, () =>
      settle(guardedAxios()({ method: 'get', url: INFO_URL, params: { minorversion: '75' }, headers: { authorization: `Bearer ${ACCESS_A}` } })),
    );
    expect(r.qbo.requests.map((c) => Object.keys(c.headers ?? {}).filter((k) => k.toLowerCase() === 'authorization').length)).toEqual([1, 1]);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`]);
  });
});

describe('A4.2: 401 then 401, and a forced refetch that fails', () => {
  it('401 then 401: http-401, exactly two QuickBooks requests and two Stacks fetches', async () => {
    const r = rig({ qbo: { answers: [a(401), a(401)] } });
    const o = await inCall(r, () => settle(get()));
    expect(o.ok).toBe(false);
    expect((o.error as AxiosError).response?.status).toBe(401);
    expect(o.failure).toEqual({ reason: 'http-401' });
    expect(r.qbo.requests).toHaveLength(2);
    expect(r.stacks.requests).toHaveLength(2);
  });

  it('a forced refetch answering 502 invalid_grant: renewal-failed:invalid_grant, no resend', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] }, stacks: [tokenBody(ACCESS_A), '502-invalid_grant.json'] });
    const o = await inCall(r, () => settle(get()));
    expect(o.ok).toBe(false);
    expect(o.failure).toEqual({ reason: 'renewal-failed:invalid_grant' });
    expect(r.qbo.requests).toHaveLength(1);
    expect(r.stacks.requests).toHaveLength(2);
  });

  it('Review focus 5: a forced refetch returning a changed realm is fork-error (T5’s realm rule), no resend; the company is refused', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] }, stacks: [tokenBody(ACCESS_A), tokenBody(ACCESS_B, REALM_OTHER)] });
    const o = await inCall(r, () => settle(get()));
    expect(o.failure).toEqual({ reason: 'fork-error' });
    expect(r.qbo.requests).toHaveLength(1);
    expect(r.realms.refused('garden3d')).toEqual({ reason: 'fork-error' });
  });

  it('a token for another realm from reacquire is never sent on this call’s URL: fork-error, no resend, the call’s token kept', async () => {
    const r = rig({
      qbo: { answers: [a(401), OK] },
      reacquire: async () => ({ ok: true, token: { access_token: ACCESS_B, realm_id: REALM_OTHER, expires_at: EXPIRES, company_name: 'garden3d, LLC' } }),
    });
    const o = await inCall(r, async () => {
      const out = await settle(get());
      expect(currentCall()!.token).toBe(ACCESS_A);
      return out;
    });
    expect(o.failure).toEqual({ reason: 'fork-error' });
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('a reacquire that throws is fork-error, no resend', async () => {
    const r = rig({
      qbo: { answers: [a(401), OK] },
      reacquire: () => Promise.reject(new Error('boom')),
    });
    const o = await inCall(r, () => settle(get()));
    expect(o.failure).toEqual({ reason: 'fork-error' });
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('a 401 outside a call has no company to refetch for: not resent', async () => {
    const { ax, seen } = scripted([{ status: 401 }, { status: 200 }]);
    const deps = installOn(ax);
    await expect(ax.get(INFO_URL)).rejects.toMatchObject({ response: { status: 401 } });
    expect(seen).toHaveLength(1);
    expect(deps.forced).toEqual([]);
  });
});

describe('A4.3: 429', () => {
  it('Retry-After: 7 then 200: resent after 7 s by the default timer (fake timers)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const r = rig({ qbo: { answers: [a(429, { 'Retry-After': '7' }), OK] }, realSleep: true });
    const done = inCall(r, () => settle(get()));
    await jest.advanceTimersByTimeAsync(6_999);
    expect(r.qbo.requests).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await done).toEqual({ ok: true, status: 200, failure: null });
    expect(r.qbo.requests).toHaveLength(2);
    expect(r.qbo.requests[1].path).toBe(r.qbo.requests[0].path);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`]);
    expect(r.stacks.requests).toHaveLength(1);
  });

  const waitsFor: Array<[string, string | undefined, number]> = [
    ['7', '7', 7_000],
    ['120 (capped)', '120', 30_000],
    ['300 (capped)', '300', 30_000],
    ['30', '30', 30_000],
    ['31 (capped)', '31', 30_000],
    ['missing', undefined, 2_000],
    ['abc', 'abc', 2_000],
    ['7abc', '7abc', 2_000],
    ['1.5', '1.5', 2_000],
    ['-1', '-1', 2_000],
    ['an HTTP-date', 'Wed, 18 Nov 2026 11:00:00 GMT', 2_000],
    ['0 (at once)', '0', 0],
  ];
  for (const [name, value, ms] of waitsFor) {
    it(`Retry-After ${name}: one wait of ${ms} ms, then one resend`, async () => {
      const r = rig({ qbo: { answers: [a(429, value === undefined ? undefined : { 'Retry-After': value }), OK] } });
      expect(await inCall(r, () => settle(get()))).toEqual({ ok: true, status: 200, failure: null });
      expect(r.waits).toEqual([ms]);
      expect(r.qbo.requests).toHaveLength(2);
    });
  }

  it('429 then 429: http-429 with the last answer’s intuit_tid, two requests, one wait', async () => {
    const r = rig({ qbo: { answers: [a(429, { intuit_tid: 'tid-first' }), a(429, { intuit_tid: 'tid-last' })] } });
    const o = await inCall(r, () => settle(get()));
    expect(o.failure).toEqual({ reason: 'http-429', intuitTid: 'tid-last' });
    expect(r.qbo.requests).toHaveLength(2);
    expect(r.waits).toEqual([2_000]);
  });
});

describe('A4.3b: mixed sequences, one resend per status, the budget per request', () => {
  it('two identical companyinfo requests in one call each get their own 401 resend (four requests, success)', async () => {
    const r = rig({ qbo: { answers: [a(401), OK, a(401), OK] } });
    const o = await inCall(r, async () => [await settle(get()), await settle(get())]);
    expect(o).toEqual([
      { ok: true, status: 200, failure: null },
      { ok: true, status: 200, failure: null },
    ]);
    expect(r.qbo.requests).toHaveLength(4);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_C}`]);
    expect(r.forced).toEqual(['garden3d', 'garden3d']);
  });

  it('two identical requests at once each get their own 401 resend', async () => {
    const r = rig({ qbo: { answers: [a(401), a(401), OK, OK] } });
    const o = await inCall(r, () => Promise.all([settle(get()), settle(get())]));
    expect(o.map((x) => x.status)).toEqual([200, 200]);
    expect(r.qbo.requests).toHaveLength(4);
    expect(r.forced).toEqual(['garden3d', 'garden3d']);
  });

  it('401 → 429 → 200 on a query: three requests, success (the guard’s P1 [401], P1 [429], P1)', async () => {
    const r = rig({ qbo: { answers: [a(401), a(429), OK] } });
    expect(await inCall(r, () => settle(getQuery()))).toEqual({ ok: true, status: 200, failure: null });
    expect(r.qbo.requests).toHaveLength(3);
    expect(new Set(r.qbo.requests.map((c) => c.path)).size).toBe(1);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`]);
    expect(r.waits).toEqual([2_000]);
  });

  it('429 → 401 → 200 on a query: three requests, success', async () => {
    const r = rig({ qbo: { answers: [a(429), a(401), OK] } });
    expect(await inCall(r, () => settle(getQuery()))).toEqual({ ok: true, status: 200, failure: null });
    expect(r.qbo.requests).toHaveLength(3);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`]);
  });

  it('401 → 429 → 500: http-500 with the last answer’s tid', async () => {
    const r = rig({ qbo: { answers: [a(401, { intuit_tid: 'tid-1' }), a(429, { intuit_tid: 'tid-2' }), a(500, { intuit_tid: 'tid-3' })] } });
    const o = await inCall(r, () => settle(getQuery()));
    expect(o.failure).toEqual({ reason: 'http-500', intuitTid: 'tid-3' });
    expect(r.qbo.requests).toHaveLength(3);
  });

  it('401 → 429 → 401: http-401 after three requests, no fourth', async () => {
    const r = rig({ qbo: { answers: [a(401), a(429), a(401), OK] } });
    const o = await inCall(r, () => settle(getQuery()));
    expect(o.failure).toEqual({ reason: 'http-401' });
    expect(r.qbo.requests).toHaveLength(3);
    expect(r.forced).toHaveLength(1);
  });

  it('429 → 401 → 429: http-429 after three requests, no fourth', async () => {
    const r = rig({ qbo: { answers: [a(429), a(401), a(429), OK] } });
    const o = await inCall(r, () => settle(getQuery()));
    expect(o.failure).toEqual({ reason: 'http-429' });
    expect(r.qbo.requests).toHaveLength(3);
    expect(r.waits).toHaveLength(1);
  });
});

describe('A4.3c: resends are for GET only', () => {
  for (const status of [401, 429]) {
    it(`a POST that gets a ${status} is never resent; its status is recorded and returned`, async () => {
      const { ax, seen } = scripted([{ status }, { status: 200 }]);
      const deps = installOn(ax);
      const o = await plainCall(() => settle(ax.post(INFO_URL, { a: 1 })));
      expect(o.ok).toBe(false);
      expect((o.error as AxiosError).response?.status).toBe(status);
      expect(o.failure).toEqual({ reason: `http-${status}` });
      expect(seen).toHaveLength(1);
      expect([deps.forced, deps.waits]).toEqual([[], []]);
    });
  }
});

describe('A4.4: other statuses', () => {
  it('500 with intuit_tid fake-tid-0001: http-500 with that tid, no resend', async () => {
    const r = rig({ qbo: { answers: [a(500, { intuit_tid: 'fake-tid-0001' }), OK] } });
    const o = await inCall(r, () => settle(get()));
    expect(o.failure).toEqual({ reason: 'http-500', intuitTid: 'fake-tid-0001' });
    expect(r.qbo.requests).toHaveLength(1);
  });

  for (const [name, tid] of [
    ['65 characters', 'a'.repeat(65)],
    ['a space', 'tid one'],
    ['an underscore', 'tid_one'],
    ['empty', ''],
  ] as const) {
    it(`a 500 whose intuit_tid has ${name} gives no tid`, async () => {
      const r = rig({ qbo: { answers: [a(500, { intuit_tid: tid })] } });
      const o = await inCall(r, () => settle(get()));
      expect(o.failure).toEqual({ reason: 'http-500' });
    });
  }

  it('a 64-character tid is kept', async () => {
    const tid = 'A-9'.repeat(21) + 'z';
    const r = rig({ qbo: { answers: [a(500, { intuit_tid: tid })] } });
    expect((await inCall(r, () => settle(get()))).failure).toEqual({ reason: 'http-500', intuitTid: tid });
  });

  it('503: http-503, no resend', async () => {
    const r = rig({ qbo: { answers: [a(503), OK] } });
    expect((await inCall(r, () => settle(get()))).failure).toEqual({ reason: 'http-503' });
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('a status that isn’t three digits is fork-error', async () => {
    const { ax } = scripted([{ status: 1000 }]);
    installOn(ax);
    expect((await plainCall(() => settle(ax.get(INFO_URL)))).failure).toEqual({ reason: 'fork-error' });
  });
});

describe('A4.4b: a 400’s fault text (D6)', () => {
  const fault = (error: unknown) => ({ Fault: { Error: [error], type: 'ValidationFault' } });

  it('Message and a Detail with a line break and 600 characters: one line, at most 500 code points after “QuickBooks said: ”', async () => {
    const detail = 'line one\nline two ' + 'x'.repeat(600);
    const r = rig({ qbo: { answers: [a(400, { intuit_tid: 'tid-400' }, fault({ Message: 'Invalid query', Detail: detail, code: '4000' }))] } });
    const o = await inCall(r, () => settle(getQuery()));
    const said = Array.from(`Invalid query: ${detail.replace('\n', ' ')}`).slice(0, 500).join('');
    expect(o.failure).toEqual({ reason: 'http-400', intuitTid: 'tid-400', text: `QuickBooks answered 400. QuickBooks said: ${said}` });
    const text = o.failure!.text!;
    expect(text).not.toMatch(/[\n\r]/);
    expect(Array.from(text.slice(text.indexOf('QuickBooks said: ') + 'QuickBooks said: '.length))).toHaveLength(500);
  });

  it('control and separator characters become spaces, and the text is trimmed; a cut never splits a surrogate pair', async () => {
    const r = rig({ qbo: { answers: [a(400, undefined, fault({ Message: '\t Bad\u2028query\u2029', Detail: '😀'.repeat(600) }))] } });
    const o = await inCall(r, () => settle(getQuery()));
    const said = Array.from(`Bad query : ${'😀'.repeat(600)}`).slice(0, 500).join('');
    expect(o.failure!.text).toBe(`QuickBooks answered 400. QuickBooks said: ${said}`);
  });

  it('Message only, Detail only, or one of them empty: the other alone', async () => {
    const r = rig({
      qbo: {
        answers: [
          a(400, undefined, fault({ Message: 'Invalid query' })),
          a(400, undefined, fault({ Detail: 'no such field' })),
          a(400, undefined, fault({ Message: 'Invalid query', Detail: '' })),
          a(400, undefined, fault({ Message: '', Detail: 'no such field' })),
        ],
      },
    });
    const o = await inCall(r, async () => [await settle(get()), await settle(get()), await settle(get()), await settle(get())]);
    expect(o.map((x) => x.failure!.text)).toEqual([
      'QuickBooks answered 400. QuickBooks said: Invalid query',
      'QuickBooks answered 400. QuickBooks said: no such field',
      'QuickBooks answered 400. QuickBooks said: Invalid query',
      'QuickBooks answered 400. QuickBooks said: no such field',
    ]);
  });

  const noText: Array<[string, unknown]> = [
    ['no fault body', { other: 1 }],
    ['an empty body', ''],
    ['a body that isn’t JSON', 'not json'],
    ['a Fault without Error', { Fault: {} }],
    ['an empty Error list', { Fault: { Error: [] } }],
    ['an Error that isn’t an object', { Fault: { Error: ['x'] } }],
    ['neither Message nor Detail as text', fault({ Message: 5, Detail: '' })],
    ['a Message of control characters only', fault({ Message: '\n\t ' })],
  ];
  for (const [name, body] of noText) {
    it(`a 400 with ${name}: no fault text`, async () => {
      const r = rig({ qbo: { answers: [a(400, undefined, body)] } });
      expect((await inCall(r, () => settle(get()))).failure).toEqual({ reason: 'http-400' });
    });
  }

  it('a 400 fault given as text (a text response) is read', async () => {
    const { ax } = scripted([{ status: 400, data: JSON.stringify(fault({ Message: 'Invalid query' })) }]);
    installOn(ax);
    // responseType text: axios leaves the body as the string it was.
    const o = await plainCall(() => settle(ax.get(INFO_URL, { responseType: 'text' })));
    expect(typeof ((o.error as AxiosError).response?.data)).toBe('string');
    expect(o.failure).toEqual({ reason: 'http-400', text: 'QuickBooks answered 400. QuickBooks said: Invalid query' });
  });

  it('a 401 and a 403 with a fault body give no fault text', async () => {
    const body = fault({ Message: 'AuthenticationFailed', Detail: 'token rejected' });
    const r = rig({ qbo: { answers: [a(401, undefined, body), a(401, undefined, body), a(403, undefined, body)] } });
    const o = await inCall(r, async () => [await settle(get()), await settle(get())]);
    expect(o.map((x) => x.failure)).toEqual([{ reason: 'http-401' }, { reason: 'http-403' }]);
  });

  it('the call’s access token and STACKS_QBO_TOKEN in the Detail are [redacted]', async () => {
    const r = rig({ qbo: { answers: [a(400, undefined, fault({ Message: `key ${KEY}`, Detail: `bearer ${ACCESS_A} and ${KEY}.` }))] } });
    const o = await inCall(r, () => settle(getQuery()));
    expect(o.failure!.text).toBe('QuickBooks answered 400. QuickBooks said: key [redacted]: bearer [redacted] and [redacted].');
  });

  it('a 401, the resend, then a 400 whose Detail echoes the new token: [redacted]; the call’s next request carries the new token', async () => {
    const r = rig({ qbo: { answers: [a(401), a(400, undefined, fault({ Message: 'Invalid query', Detail: `token ${ACCESS_B}` })), OK] } });
    const o = await inCall(r, async () => [await settle(getQuery()), await settle(get())]);
    expect(o[0].failure).toEqual({ reason: 'http-400', text: 'QuickBooks answered 400. QuickBooks said: Invalid query: token [redacted]' });
    expect(o[1]).toEqual({ ok: true, status: 200, failure: null });
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`]);
  });

  it('T6-1: a request still holding the call’s earlier token, answered 400 echoing it after a 401 elsewhere replaced the call’s token: [redacted]', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const seen: any[] = [];
    const ax = axios.create({
      adapter: async (config: any) => {
        seen.push(config);
        const n = seen.length;
        const respond = (status: number, data: unknown) => {
          const response = { status, statusText: String(status), headers: {}, data, config, request: {} };
          if (status === 200) return response;
          throw new AxiosError(`status ${status}`, 'ERR_BAD_RESPONSE', config, {}, response as any);
        };
        if (n === 1) return respond(401, {});
        if (n === 2) {
          await gate;
          return respond(400, fault({ Message: 'Invalid query', Detail: `token ${ACCESS_A}` }));
        }
        open();
        return respond(200, {});
      },
    });
    installOn(ax);
    const [first, second] = await plainCall(() =>
      Promise.all([
        settle(ax.get(INFO_URL, { headers: { Authorization: `Bearer ${ACCESS_A}` } })),
        settle(ax.get(QUERY_URL, { headers: { authorization: `Bearer ${ACCESS_A}` } })),
      ]),
    );
    expect(first.ok).toBe(true);
    expect(seen.map((c) => c.headers.Authorization ?? c.headers.authorization)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`]);
    // secrets() answers the call's token at record time, ACCESS_B: only the request's own bearer names ACCESS_A.
    expect(second.failure).toEqual({ reason: 'http-400', text: 'QuickBooks answered 400. QuickBooks said: Invalid query: token [redacted]' });
    expect(second.failure!.text).not.toContain(ACCESS_A);
  });

  // TB6-1: the request's own bearer, as its Authorization header spells it. The call holds token A, so secrets()
  // never names OWN: only bearerOf decides each case.
  const OWN = ['qbo', 'test', 'own', 'bearer'].join('-');
  const ownBearer: Array<[string, string, string]> = [
    ['a lowercase scheme', `bearer ${OWN}`, 'token [redacted]'],
    ['two spaces after the scheme', `Bearer  ${OWN}`, 'token [redacted]'],
    ['a tab after the scheme', `Bearer\t${OWN}`, 'token [redacted]'],
  ];
  for (const [name, value, said] of ownBearer) {
    it(`TB6-1: the request’s own bearer with ${name} is redacted`, async () => {
      const { ax } = scripted([{ status: 400, data: fault({ Message: `token ${OWN}` }) }]);
      installOn(ax);
      const o = await plainCall(() => settle(ax.get(INFO_URL, { headers: { Authorization: value } })));
      expect(o.failure).toEqual({ reason: 'http-400', text: `QuickBooks answered 400. QuickBooks said: ${said}` });
    });
  }

  it('TB6-1: a scheme word not at the start is not a bearer: the whole header value is what is redacted', async () => {
    const value = 'Token Bearer plain-value';
    const { ax } = scripted([{ status: 400, data: fault({ Message: 'said Token plain-value', Detail: `whole ${value}` }) }]);
    installOn(ax);
    const o = await plainCall(() => settle(ax.get(INFO_URL, { headers: { Authorization: value } })));
    expect(o.failure!.text).toBe('QuickBooks answered 400. QuickBooks said: said Token plain-value: whole [redacted]');
  });

  it('TB6-2: an intuit_tid equal to the call’s token or the request’s own bearer is dropped; another is kept', async () => {
    // Both tokens are built at runtime and match ^[A-Za-z0-9-]{1,64}$.
    expect([/^[A-Za-z0-9-]{1,64}$/.test(ACCESS_A), /^[A-Za-z0-9-]{1,64}$/.test(OWN)]).toEqual([true, true]);
    const { ax } = scripted([
      { status: 500, headers: { intuit_tid: ACCESS_A } },
      { status: 500, headers: { intuit_tid: OWN } },
      { status: 500, headers: { intuit_tid: 'tid-ok' } },
    ]);
    installOn(ax);
    const o = await plainCall(async () => {
      const auth = { headers: { Authorization: `Bearer ${OWN}` } };
      return [await settle(ax.get(INFO_URL)), await settle(ax.get(INFO_URL, auth)), await settle(ax.get(INFO_URL, auth))];
    });
    expect(o.map((x) => x.failure)).toEqual([{ reason: 'http-500' }, { reason: 'http-500' }, { reason: 'http-500', intuitTid: 'tid-ok' }]);
  });

  it('secrets are replaced longest first, and an absent or empty secret replaces nothing', async () => {
    const short = ['qbo', 'test'].join('-');
    const { ax } = scripted([{ status: 400, data: fault({ Message: `${ACCESS_A} ${short}` }) }]);
    installOn(ax, { secrets: () => [short, undefined, '', ACCESS_A] });
    const o = await plainCall(() => settle(ax.get(INFO_URL)));
    expect(o.failure!.text).toBe('QuickBooks answered 400. QuickBooks said: [redacted] [redacted]');
  });
});

describe('A4.5: the 15 s limit', () => {
  it('no answer within 15 s: timeout, after exactly 15 s, one request', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const r = rig({ qbo: { holdUntil: new Promise<void>(() => {}) } });
    let settled = false;
    const done = inCall(r, () => settle(get())).finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(QBO_LIMIT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const o = await done;
    expect(QBO_LIMIT_MS).toBe(15_000);
    expect(o.failure).toEqual({ reason: 'timeout' });
    expect((o.error as AxiosError).code).toBe('ECONNABORTED');
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('axios’ clarified timeout (ETIMEDOUT, made by axios with no cause) on a QuickBooks GET is timeout too', async () => {
    const { ax } = scripted([{ throws: (c: any) => new AxiosError('timeout of 15000ms exceeded', 'ETIMEDOUT', c) }]);
    installOn(ax);
    expect((await plainCall(() => settle(ax.get(INFO_URL)))).failure).toEqual({ reason: 'timeout' });
  });

  it('the limit is set on a QuickBooks GET only: not on a POST, a look-alike host or Stacks', async () => {
    const { ax, seen } = scripted([{ status: 200 }]);
    installOn(ax);
    await plainCall(async () => {
      await ax.get(INFO_URL);
      await ax.post(INFO_URL, {});
      await ax.get(`${LOOKALIKE}/v3/company/${REALM}/companyinfo/${REALM}`);
      await ax.get(`${STACKS}/api/qbo/access_token?enterprise=garden3d`);
      await ax.get(`/v3/company/${REALM}/companyinfo/${REALM}`, { baseURL: QBO });
    });
    expect(seen.map((c) => c.timeout)).toEqual([QBO_LIMIT_MS, 0, 0, 0, QBO_LIMIT_MS]);
  });

  it('a request with no parsable URL is not QuickBooks’', async () => {
    const { ax, seen } = scripted([{ status: 200 }]);
    installOn(ax);
    await ax.get('http://[bad');
    expect(seen[0].timeout).toBe(0);
  });

  it('an axios timeout on a QuickBooks POST (its own limit, not the fork’s) is fork-error', async () => {
    const { ax } = scripted([{ throws: (c: any) => new AxiosError('timeout of 1ms exceeded', 'ECONNABORTED', c) }]);
    installOn(ax);
    expect((await plainCall(() => settle(ax.post(INFO_URL, {})))).failure).toEqual({ reason: 'fork-error' });
  });
});

describe('A4.5b: no answer other than the limit is fork-error, not resent', () => {
  for (const fail of ['reset', 'refused', 'tls', 'socket-timeout', 'socket-aborted'] as const) {
    it(`${fail}: fork-error, one request`, async () => {
      const r = rig({ qbo: { fail } });
      const o = await inCall(r, () => settle(get()));
      expect(o.failure).toEqual({ reason: 'fork-error' });
      expect(r.qbo.requests).toHaveLength(1);
      expect(r.waits).toEqual([]);
    });
  }

  it('a guard refusal (another realm on the URL): fork-error, nothing sent', async () => {
    const r = rig();
    const o = await inCall(r, () => settle(get(`${QBO}/v3/company/${REALM_OTHER}/companyinfo/${REALM_OTHER}`)));
    expect(o.error).toBeInstanceOf(GuardRefusedError);
    expect(o.failure).toEqual({ reason: 'fork-error' });
    expect(r.qbo.requests).toHaveLength(0);
    // T6-2: a refused Stacks request (an enterprise not in the keys) can't be told by host either: it records fork-error, replacing a kept reason.
    const stacksRefused = await runInCall('garden3d', async () => {
      recordFailure({ reason: 'http-500' });
      return settle(guardedAxios()({ method: 'get', url: `${STACKS}/api/qbo/access_token?enterprise=nope`, headers: { 'X-Api-Key': KEY } }));
    });
    expect([stacksRefused.error instanceof GuardRefusedError, stacksRefused.failure, r.stacks.requests.length]).toEqual([true, { reason: 'fork-error' }, 1]);
  });

  const odd: Array<[string, unknown]> = [
    ['a TypeError', new TypeError('x')],
    ['null', null],
    ['a string', 'x'],
  ];
  for (const [name, thrown] of odd) {
    it(`a throw of ${name} with no config: fork-error`, async () => {
      const { ax } = scripted([{ throws: thrown }]);
      installOn(ax);
      expect((await plainCall(() => settle(ax.get(INFO_URL)))).failure).toEqual({ reason: 'fork-error' });
    });
  }

  it('an AxiosError with an unknown code and no answer: fork-error, never timeout', async () => {
    const { ax } = scripted([{ throws: (c: any) => new AxiosError('odd', 'ERR_ODD', c) }]);
    installOn(ax);
    expect((await plainCall(() => settle(ax.get(INFO_URL)))).failure).toEqual({ reason: 'fork-error' });
  });

  it('an AxiosError with no code: fork-error', async () => {
    const { ax } = scripted([{ throws: (c: any) => new AxiosError('odd', undefined, c) }]);
    installOn(ax);
    expect((await plainCall(() => settle(ax.get(INFO_URL)))).failure).toEqual({ reason: 'fork-error' });
  });
});

describe('A4.7’s interceptor clause and review focus 1: only QuickBooks answers are read', () => {
  it('a 401 resent successfully leaves nothing recorded (a later handler throw answers fork-error, not http-401)', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] } });
    expect((await inCall(r, () => settle(get()))).failure).toBeNull();
  });

  it('a later QuickBooks success in the call clears a recorded failure', async () => {
    const r = rig({ qbo: { answers: [a(500), OK] } });
    const o = await inCall(r, async () => [await settle(get()), await settle(get())]);
    expect(o.map((x) => x.failure)).toEqual([{ reason: 'http-500' }, null]);
  });

  it('a recorded QuickBooks 500, then a Stacks 200 through guardedAxios() in the same call: still http-500', async () => {
    const r = rig({ qbo: { answers: [a(500)] } });
    const o = await inCall(r, async () => {
      await settle(get());
      const t = await r.client.get('garden3d', { force: true });
      expect(t.ok).toBe(true);
      return currentCall()!.failure;
    });
    expect(o).toEqual({ reason: 'http-500' });
    expect(r.stacks.requests).toHaveLength(2);
  });

  for (const [status, more] of [
    [401, {}],
    [429, { 'Retry-After': '1' }],
  ] as const) {
    it(`a Stacks ${status} through guardedAxios() passes untouched: no resend, no refetch, no wait, no record, no clear`, async () => {
      const r = rig({ stacks: [{ status, headers: more, body: { error: 'x' } }] });
      const o = await runInCall('garden3d', async () => {
        recordFailure({ reason: 'http-500' });
        return settle(guardedAxios()({ method: 'get', url: `${STACKS}/api/qbo/access_token?enterprise=garden3d`, headers: { 'X-Api-Key': KEY } }));
      });
      expect(o.ok).toBe(false);
      expect((o.error as AxiosError).response?.status).toBe(status);
      expect(o.failure).toEqual({ reason: 'http-500' });
      expect(r.stacks.requests).toHaveLength(1);
      expect(r.stacks.requests[0].hostname).toBe(STACKS_HOST);
      expect([r.forced, r.waits]).toEqual([[], []]);
    });
  }

  it('a Stacks transport failure passes untouched (the Stacks client maps it)', async () => {
    const r = rig({ stacks: [{ refuse: 'reset' }] });
    const o = await runInCall('garden3d', () =>
      settle(guardedAxios()({ method: 'get', url: `${STACKS}/api/qbo/access_token?enterprise=garden3d`, headers: { 'X-Api-Key': KEY } })),
    );
    expect(o.ok).toBe(false);
    expect(o.failure).toBeNull();
    expect(r.stacks.requests).toHaveLength(1);
  });

  it('a look-alike host (quickbooks.api.intuit.com.example.test): a 401 and a 429 are not resent or recorded, and a 200 clears nothing', async () => {
    const url = `${LOOKALIKE}/v3/company/${REALM}/companyinfo/${REALM}`;
    const { ax, seen } = scripted([{ status: 401 }, { status: 429 }, { status: 200 }]);
    const deps = installOn(ax);
    const o = await plainCall(async () => {
      recordFailure({ reason: 'http-500' });
      return [await settle(ax.get(url)), await settle(ax.get(url)), await settle(ax.get(url))];
    });
    expect(o.map((x) => [x.ok, x.failure])).toEqual([
      [false, { reason: 'http-500' }],
      [false, { reason: 'http-500' }],
      [true, { reason: 'http-500' }],
    ]);
    expect(seen).toHaveLength(3);
    expect([deps.forced, deps.waits]).toEqual([[], []]);
  });

  it('a QuickBooks POST success clears a recorded failure (the status of a write is the host’s answer)', async () => {
    const { ax } = scripted([{ status: 200 }]);
    installOn(ax);
    const o = await plainCall(async () => {
      recordFailure({ reason: 'http-500' });
      return settle(ax.post(INFO_URL, {}));
    });
    expect(o.failure).toBeNull();
  });
});

describe('the resend’s form', () => {
  it('is ax({ ...config, headers }): the answered request’s own config, only Authorization changed (any casing), no budget on it', async () => {
    const { ax, seen } = scripted([{ status: 401 }, { status: 200 }]);
    const sent: any[] = [];
    const spy = Object.assign((cfg: any) => {
      sent.push(cfg);
      return ax(cfg);
    }, { interceptors: ax.interceptors }) as unknown as AxiosInstance;
    installOn(spy);
    const o = await plainCall(() => settle(ax.get(INFO_URL, { headers: { authorization: `Bearer ${ACCESS_A}`, 'X-Other': 'kept' } })));
    expect(o).toEqual({ ok: true, status: 200, failure: null });
    expect(sent).toHaveLength(1);
    const first = seen[0];
    expect(Object.keys(sent[0]).sort()).toEqual(Object.keys(first).sort());
    for (const k of Object.keys(first)) if (k !== 'headers') expect(sent[0][k]).toBe(first[k]);
    const names = Object.keys(sent[0].headers);
    expect(names.filter((k) => k.toLowerCase() === 'authorization')).toEqual(['Authorization']);
    expect(sent[0].headers.Authorization).toBe(`Bearer ${ACCESS_B}`);
    expect(sent[0].headers['X-Other']).toBe('kept');
  });
});

describe('headers that aren’t text', () => {
  it('a Retry-After or intuit_tid given as a list is not read: a 2 s wait, then no tid', async () => {
    const { ax, seen } = scripted([
      { status: 429, headers: { 'retry-after': ['7'] as any } },
      { status: 500, headers: { intuit_tid: ['tid-1'] as any } },
    ]);
    const deps = installOn(ax);
    const o = await plainCall(() => settle(ax.get(INFO_URL)));
    expect(deps.waits).toEqual([2_000]);
    expect(seen).toHaveLength(2);
    expect(o.failure).toEqual({ reason: 'http-500' });
  });
});

describe('T7-1: the send mark', () => {
  it('each QuickBooks GET takes a mark as it is sent, and reacquire gets the mark of the request that got the 401', async () => {
    const { ax, seen } = scripted([{ status: 200 }, { status: 401 }, { status: 200 }]);
    const deps = installOn(ax);
    // A non-QuickBooks request takes no mark.
    await plainCall(() => settle(ax.get('https://stacks.example.test/x')));
    const o = await plainCall(() => settle(ax.get(INFO_URL)));
    expect(o.ok).toBe(true);
    // The first QuickBooks GET took 101; its resend, sent after the reacquire, took 102.
    expect(deps.sentAts).toEqual([101]);
    const markOf = (c: any) => Object.getOwnPropertySymbols(Object(c.transformResponse)).map((k) => c.transformResponse[k]);
    expect(seen.map(markOf)).toEqual([[], [101], [102]]);
    // Each a copy: axios' shared default transformResponse holds no mark.
    expect(Object.getOwnPropertySymbols(axios.defaults.transformResponse)).toEqual([]);
    expect(Object.getOwnPropertySymbols((guardedAxios().defaults as any).transformResponse)).toEqual([]);
    // Outside the headers.
    for (const c of seen) expect(JSON.stringify(c.headers)).not.toMatch(/10[12]/);
  });

  it('through 291\'s guard (which sends a fresh config), reacquire still gets the mark the 401\'s request was sent with', async () => {
    const sentAts: Array<number | undefined> = [];
    const r = rig({
      qbo: { answers: [a(401), OK] },
      reacquire: (company, sentAt) => {
        sentAts.push(sentAt);
        return r.client.get(company, { force: true, sentAt });
      },
    });
    const o = await inCall(r, async () => {
      const before = r.client.mark();
      const out = await settle(get());
      return { out, before };
    });
    expect(o.out.failure).toBeNull();
    // The request's mark was taken after `before` and before the forced fetch began.
    expect(sentAts).toEqual([o.before + 1]);
  });

  it('a caller\'s own transformResponse function is never marked: the mark sits on a per-request copy', async () => {
    const { ax, seen } = scripted([{ status: 200, data: '{}' }]);
    installOn(ax);
    const own = (data: unknown) => data;
    await plainCall(() => settle(ax.get(INFO_URL, { transformResponse: own })));
    expect(Object.getOwnPropertySymbols(own)).toEqual([]);
    expect([Array.isArray(seen[0].transformResponse), seen[0].transformResponse.length, seen[0].transformResponse[0]]).toEqual([true, 1, own]);
    expect(Object.getOwnPropertySymbols(seen[0].transformResponse)).toHaveLength(1);
  });

  it('a POST to QuickBooks takes no mark', async () => {
    const { ax, seen } = scripted([{ status: 200 }]);
    installOn(ax);
    await plainCall(() => settle(ax.post(INFO_URL, {})));
    expect(Object.getOwnPropertySymbols(Object(seen[0].transformResponse))).toEqual([]);
  });
});

describe('eject', () => {
  it('after eject() a 401 is not resent, nothing is recorded and no limit is set', async () => {
    const { ax, seen } = scripted([{ status: 401 }, { status: 200 }]);
    const handle = installQboInterceptors(ax, {
      reacquire: async () => {
        throw new Error('not called');
      },
      mark: () => {
        throw new Error('not called');
      },
      secrets: () => [],
    });
    handle.eject();
    const o = await plainCall(() => settle(ax.get(INFO_URL)));
    expect(o.ok).toBe(false);
    expect(o.failure).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0].timeout).toBe(0);
  });

  it('eject on the guarded instance removes both: the guard alone answers', async () => {
    const r = rig({ qbo: { answers: [a(401), OK] }, noInstall: true });
    const handle = installQboInterceptors(guardedAxios() as unknown as AxiosInstance, { reacquire: (c, sentAt) => r.client.get(c, { force: true, sentAt }), mark: () => r.client.mark(), secrets: () => [] });
    const before = [(guardedAxios().interceptors.request as any).handlers.filter(Boolean).length, (guardedAxios().interceptors.response as any).handlers.filter(Boolean).length];
    handle.eject();
    const after = [(guardedAxios().interceptors.request as any).handlers.filter(Boolean).length, (guardedAxios().interceptors.response as any).handlers.filter(Boolean).length];
    expect([before[0] - after[0], before[1] - after[1]]).toEqual([1, 1]);
    const o = await inCall(r, () => settle(get()));
    expect(o.failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(1);
  });
});

describe('the token path', () => {
  it('the module holds no refresh token, client id, secret, disk write, process.env, fetch( or .request(', () => {
    const src = readFileSync(fileURLToPath(new URL('../../../src/clients/qbo-transport.ts', import.meta.url)), 'utf8');
    for (const word of [/refresh/i, /client_?id/i, /client_?secret/i, /process\.env/, /\bfs\b/, /writeFile/, /fetch\(/, /\.request\(/]) expect(src).not.toMatch(word);
    expect(src).toMatch(/\breacquire\b/);
  });
});

