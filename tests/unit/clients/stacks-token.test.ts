// Sanctuary Computer (quickbooks-mcp-286): the Stacks token client, contract 1.1 §2 (A1.1-A1.7, A1.3b, A2.2, A2.6's Stacks
// path, A3.6 (a)-(d), A3.7's Stacks half). Every request goes through 291's guard to the stub network below it.
import { describe, it as jestIt, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork, type StubCall, type StubTable } from '../../fakes/stub-network.js';
import { expectServedBy, stacksFake, stacksFixture, type StacksAnswer, type StacksFakeOpts, type StacksStep } from '../../fakes/stacks-token.js';
import { startTestGuard } from '../../helpers/guard.js';
import { guardedAxios } from '../../../src/http-guard.js';
import { parseCompanies, type Company } from '../../../src/clients/companies.js';
import { runInCall, type Failure } from '../../../src/clients/call-context.js';
import type { Config } from '../../../src/clients/config.js';
import { cleanName } from '../../../src/helpers/name-fold.js';
import { createRealmStore, StacksTokenClient, type RealmStore, type TokenResult } from '../../../src/clients/stacks-token.js';

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
const COMPANIES_TWO = parseCompanies(readFileSync(fakes('entities-two.json'), 'utf8'));
const KEYS = COMPANIES.map((c) => c.key);

const STACKS = 'https://stacks.example.test';
const HOST = 'stacks.example.test';
// Built at runtime: no secret-shaped literal sits in this file.
const KEY = ['fake', 'stacks', 'key'].join('-');
const ACCESS = ['qbo', 'test', 'access', 'a'].join('-');
const ACCESS_B = ['qbo', 'test', 'access', 'b'].join('-');
const FIXTURE_ACCESS = (stacksFixture('200-garden3d.json').body as Record<string, string>).access_token;

const REALM = '9990000000000002';
const REALM_OTHER = '9990000000000009';
const EXPIRES = '2026-11-18T12:00:00Z';
const EXPIRES_MS = Date.parse(EXPIRES);
const MIN = 60_000;
const NOW = EXPIRES_MS - 50 * MIN;

const NBSP = String.fromCharCode(0xa0);
const IDEO = String.fromCharCode(0x3000);
const BOM = String.fromCharCode(0xfeff);

const cfgOf = (url = STACKS, companies: readonly Company[] = COMPANIES): Config => ({ stacksUrl: new URL(url), stacksKey: KEY, companies, mode: 'read' });

/** A 200 token body for garden3d with `over` applied (a key set to undefined is left out). */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  const b: Record<string, unknown> = { enterprise: 'garden3d', realm_id: REALM, access_token: ACCESS, expires_at: EXPIRES, company_name: 'garden3d, LLC', ...over };
  for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
  return b;
}
const ok200 = (b: unknown): StacksAnswer => ({ status: 200, headers: { 'cache-control': 'no-store' }, body: b });

type Rig = { fake: ReturnType<typeof stacksFake>; realms: RealmStore; client: StacksTokenClient; cfg: Config; clock: { now: number } };
function rig(opts: StacksFakeOpts, more: { cfg?: Config; now?: number; realms?: RealmStore } = {}): Rig {
  const fake = stacksFake(opts);
  table = fake.handler;
  const realms = more.realms ?? createRealmStore();
  const clock = { now: more.now ?? NOW };
  const cfg = more.cfg ?? cfgOf();
  const client = new StacksTokenClient(cfg, realms, { now: () => clock.now });
  return { fake, realms, client, cfg, clock };
}

const header = (call: StubCall, name: string): unknown => {
  const entry = Object.entries(call.headers ?? {}).find(([k]) => k.toLowerCase() === name);
  return entry?.[1];
};
const reason = (r: TokenResult) => (r.ok ? 'token' : r.failure.reason);
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Every failure any test saw, and every stderr write: neither may hold a token or the key. */
const seenFailures: Failure[] = [];
let stderr: string[] = [];
const watch = (r: TokenResult): TokenResult => {
  if (!r.ok) seenFailures.push(r.failure);
  return r;
};

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
  restoreGuard();
  jest.useRealTimers();
  jest.restoreAllMocks();
  expect(trap.reached).toEqual([]);
  for (const s of stderr) for (const secret of [KEY, ACCESS, ACCESS_B, FIXTURE_ACCESS]) expect(s).not.toContain(secret);
  net.calls.length = 0;
  ran++;
});
// Secrets (T5-5): no failure any case watched holds an access token or the key. The floor and the `reported` check
// apply only when every registered case ran (T5-2-2), so a `-t` run of one case passes.
afterAll(() => {
  const text = JSON.stringify(seenFailures);
  for (const secret of [KEY, ACCESS, ACCESS_B, FIXTURE_ACCESS]) expect(text).not.toContain(secret);
  if (ran === registered) {
    expect(seenFailures.length).toBeGreaterThan(60);
    expect(seenFailures.some((f) => f.reported !== undefined)).toBe(true);
  }
  // A1.8: the fixtures A1.1 and A1.5 are named for, each served by those cases.
  expectServedBy('A1.1', ['200-garden3d.json']);
  expectServedBy('A1.5', ['403.json', '404.json', '409.json', '502-invalid_grant.json', '502-proxy.json', '502-unavailable.json']);
});

describe('createRealmStore', () => {
  it('keeps a realm and a refusal per company, each store its own', () => {
    const a = createRealmStore();
    const b = createRealmStore();
    expect([a.kept('garden3d'), a.refused('garden3d')]).toEqual([undefined, undefined]);
    a.keep('garden3d', REALM);
    const f = { reason: 'fork-error' };
    a.refuse('garden3d', f);
    expect(a.kept('garden3d')).toBe(REALM);
    expect(a.refused('garden3d')).toBe(f);
    expect([a.kept('usb-club'), a.refused('usb-club'), b.kept('garden3d'), b.refused('garden3d')]).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('A1.1: the request', () => {
  it('one GET <STACKS_QBO_URL>/api/qbo/access_token?enterprise=garden3d with X-Api-Key, no Authorization; the token is the fixture’s four fields', async () => {
    const { fake, client, realms } = rig({});
    const r = await client.get('garden3d');
    const fx = stacksFixture('200-garden3d.json').body as Record<string, string>;
    expect(r).toEqual({ ok: true, token: { access_token: fx.access_token, realm_id: REALM, expires_at: EXPIRES, company_name: 'garden3d, LLC' } });
    expect(fake.requests).toHaveLength(1);
    const [call] = fake.requests;
    expect([call.module, call.method, call.hostname, call.path]).toEqual(['https', 'GET', HOST, '/api/qbo/access_token?enterprise=garden3d']);
    expect(header(call, 'x-api-key')).toBe(KEY);
    expect(header(call, 'authorization')).toBeUndefined();
    // A3.7's half: the key goes only in its header, and no access token goes to Stacks.
    expect(JSON.stringify({ ...call, headers: { ...call.headers, 'X-Api-Key': undefined }, agent: undefined, options: undefined })).not.toContain(KEY);
    expect(JSON.stringify(call.headers)).not.toContain(fx.access_token);
    expect(realms.kept('garden3d')).toBe(REALM);
  });

  it('a trailing / on STACKS_QBO_URL gives the same URL, and the call succeeds', async () => {
    for (const url of [STACKS, `${STACKS}/`]) {
      const { fake, client } = rig({}, { cfg: cfgOf(url) });
      expect(reason(await client.get('garden3d'))).toBe('token');
      expect(fake.requests.map((c) => [c.hostname, c.path])).toEqual([[HOST, '/api/qbo/access_token?enterprise=garden3d']]);
    }
  });

  it('the 200 fixture’s served headers reach the client as read (cache-control: no-store) (T1-2)', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ax = guardedAxios();
    const id = ax.interceptors.response.use((res) => {
      seen.push({ ...(res.headers as object) });
      return res;
    });
    try {
      const { client } = rig({});
      expect(reason(await client.get('garden3d'))).toBe('token');
    } finally {
      ax.interceptors.response.eject(id);
    }
    const fx = stacksFixture('200-garden3d.json');
    expect(seen).toHaveLength(1);
    expect(seen[0]['cache-control']).toBe('no-store');
    for (const [k, v] of Object.entries(fx.headers)) expect(seen[0][k]).toBe(v);
  });

  it('the URL is read once, as text, at construction: a later change to cfg.stacksUrl changes nothing (T3-5)', async () => {
    const { fake, client, cfg } = rig({});
    (cfg.stacksUrl as URL).host = 'elsewhere.example.test';
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests.map((c) => c.hostname)).toEqual([HOST]);
  });

  it('the company key is the get’s company, never the call’s', async () => {
    const { fake, client } = rig({});
    const r = await runInCall('garden3d', () => client.get('usb-club'));
    expect(r.ok && r.token.realm_id).toBe('9990000000000004');
    expect(fake.requests.map((c) => c.path)).toEqual(['/api/qbo/access_token?enterprise=usb-club']);
  });

  it('a company not in the config is fork-error with no request', async () => {
    // The guard would let `nope` through, so only the client's own check keeps the request from being sent.
    restoreGuard();
    restoreGuard = startTestGuard({ stacksUrl: STACKS, keys: [...KEYS, 'nope'] });
    const { fake, client } = rig({});
    expect(watch(await client.get('nope'))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('A1.2: reuse, injected clock', () => {
  it('two calls at expires_at − 6 min fetch once; at − 5 min (the boundary) and − 4 min each fetch again', async () => {
    const { fake, client, clock } = rig({});
    clock.now = EXPIRES_MS - 6 * MIN;
    const first = await client.get('garden3d');
    const second = await client.get('garden3d');
    expect(fake.requests).toHaveLength(1);
    expect(second.ok && first.ok && second.token).toBe(first.ok && first.token);
    clock.now = EXPIRES_MS - 5 * MIN;
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(2);
    clock.now = EXPIRES_MS - 4 * MIN;
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(3);
  });

  it('with no clock given the client reads Date.now', async () => {
    const fake = stacksFake({});
    table = fake.handler;
    const now = jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const client = new StacksTokenClient(cfgOf(), createRealmStore());
    expect(reason(await client.get('garden3d'))).toBe('token');
    now.mockReturnValue(EXPIRES_MS);
    expect(reason(watch(await client.get('usb-club')))).toBe('fork-error');
    expect(fake.requests).toHaveLength(2);
  });

  it('one millisecond before the boundary still reuses', async () => {
    const { fake, client, clock } = rig({});
    clock.now = EXPIRES_MS - 5 * MIN - 1;
    await client.get('garden3d');
    await client.get('garden3d');
    expect(fake.requests).toHaveLength(1);
  });
});

describe('A1.3: single flight', () => {
  it('concurrent first calls for one company share one Stacks request', async () => {
    const { fake, client } = rig({});
    const [a, b] = await Promise.all([client.get('garden3d'), client.get('garden3d')]);
    expect(fake.requests).toHaveLength(1);
    expect(a).toBe(b);
    expect(reason(a)).toBe('token');
  });

  it('a failed fetch is not kept: the next call fetches again', async () => {
    const { fake, client } = rig({ sequence: ['409.json', '200-garden3d.json'] });
    expect(reason(watch(await client.get('garden3d')))).toBe('not-connected');
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(2);
  });

  it('different companies fetch on their own', async () => {
    const { fake, client } = rig({});
    await Promise.all([client.get('garden3d'), client.get('usb-club')]);
    expect(fake.requests.map((c) => c.path).sort()).toEqual(['/api/qbo/access_token?enterprise=garden3d', '/api/qbo/access_token?enterprise=usb-club']);
  });
});

describe('A1.3b: forced refetch and fetches in flight', () => {
  it('a forced get doesn’t join a held unforced fetch: a second fetch is made and its token used; the stale one never replaces it', async () => {
    const held = gate();
    const { fake, client } = rig({ sequence: [{ answer: ok200(body()), hold: held.wait }, ok200(body({ access_token: ACCESS_B }))] });
    const stale = client.get('garden3d');
    await settle();
    expect(fake.requests).toHaveLength(1);
    const fresh = await client.get('garden3d', { force: true });
    expect(fake.requests).toHaveLength(2);
    expect(fresh.ok && fresh.token.access_token).toBe(ACCESS_B);
    held.open();
    const old = await stale;
    expect(old.ok && old.token.access_token).toBe(ACCESS);
    const next = await client.get('garden3d');
    expect(next.ok && next.token.access_token).toBe(ACCESS_B);
    expect(fake.requests).toHaveLength(2);
  });

  it('T7-1: a forced get with sentAt after a held forced flight began does not join it: a second fetch is made and its token used', async () => {
    const held = gate();
    const { fake, client } = rig({ sequence: [{ answer: ok200(body()), hold: held.wait }, ok200(body({ access_token: ACCESS_B }))] });
    const first = client.get('garden3d', { force: true });
    await settle();
    // The request that got this 401 was sent after the held forced fetch began.
    const sentAt = client.mark();
    const fresh = await client.get('garden3d', { force: true, sentAt });
    expect(fake.requests).toHaveLength(2);
    expect(fresh.ok && fresh.token.access_token).toBe(ACCESS_B);
    held.open();
    const old = await first;
    expect(old.ok && old.token.access_token).toBe(ACCESS);
    // The older forced fetch never replaces the newer token in the cache.
    const next = await client.get('garden3d');
    expect(next.ok && next.token.access_token).toBe(ACCESS_B);
    expect(fake.requests).toHaveLength(2);
  });

  it('T7-1: a forced get with sentAt before a held forced flight began joins it: no extra fetch', async () => {
    const held = gate();
    const { fake, client } = rig({ sequence: [{ answer: ok200(body()), hold: held.wait }, ok200(body({ access_token: ACCESS_B }))] });
    // The request that got this 401 was sent before the forced fetch began.
    const sentAt = client.mark();
    const first = client.get('garden3d', { force: true });
    const joined = client.get('garden3d', { force: true, sentAt });
    await settle();
    expect(fake.requests).toHaveLength(1);
    held.open();
    expect(await joined).toBe(await first);
    expect(fake.requests).toHaveLength(1);
  });

  it('T7-1: marks only grow, and a mark sits between the fetches started before and after it', async () => {
    const { client } = rig({ sequence: [ok200(body())] });
    const m1 = client.mark();
    const m2 = client.mark();
    expect(m2).toBeGreaterThan(m1);
    await client.get('garden3d', { force: true });
    expect(client.mark()).toBe(m2 + 2);
  });

  it('T7-1: a forced get with sentAt never joins an unforced flight', async () => {
    const held = gate();
    const { fake, client } = rig({ sequence: [{ answer: ok200(body()), hold: held.wait }, ok200(body({ access_token: ACCESS_B }))] });
    const sentAt = client.mark();
    const stale = client.get('garden3d');
    const fresh = await client.get('garden3d', { force: true, sentAt });
    expect(fake.requests).toHaveLength(2);
    expect(fresh.ok && fresh.token.access_token).toBe(ACCESS_B);
    held.open();
    await stale;
  });

  it('forced gets join each other, and an unforced get joins a forced fetch in flight', async () => {
    const held = gate();
    const { fake, client } = rig({ sequence: [{ answer: ok200(body()), hold: held.wait }] });
    const a = client.get('garden3d', { force: true });
    const b = client.get('garden3d', { force: true });
    const c = client.get('garden3d');
    await settle();
    expect(fake.requests).toHaveLength(1);
    held.open();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra).toBe(rb);
    expect(rc).toBe(ra);
    expect(reason(ra)).toBe('token');
  });

  it('a stale fetch ending doesn’t end the forced flight: an unforced get after it still joins the forced fetch', async () => {
    const first = gate();
    const second = gate();
    const { fake, client } = rig({
      sequence: [
        { answer: ok200(body()), hold: first.wait },
        { answer: ok200(body({ access_token: ACCESS_B })), hold: second.wait },
      ],
    });
    const stale = client.get('garden3d');
    await settle();
    const forced = client.get('garden3d', { force: true });
    await settle();
    first.open();
    await stale;
    const joined = client.get('garden3d');
    await settle();
    expect(fake.requests).toHaveLength(2);
    second.open();
    expect(await joined).toBe(await forced);
  });

  it('a forced get drops the kept token: when the forced fetch fails, the next get fetches again', async () => {
    const { fake, client } = rig({ sequence: ['200-garden3d.json', '409.json', '200-garden3d.json'] });
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(reason(watch(await client.get('garden3d', { force: true })))).toBe('not-connected');
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(3);
  });

  it('a forced get with a token kept fetches anyway, and its token is kept', async () => {
    const { fake, client } = rig({ sequence: [ok200(body()), ok200(body({ access_token: ACCESS_B }))] });
    await client.get('garden3d');
    const forced = await client.get('garden3d', { force: true });
    expect(forced.ok && forced.token.access_token).toBe(ACCESS_B);
    const next = await client.get('garden3d');
    expect(next).toEqual(forced);
    expect(fake.requests).toHaveLength(2);
  });
});

describe('A1.4: timeout and one retry', () => {
  it('a Stacks that never answers: stacks-unreachable after exactly two requests, each aborted at 10 s; the request asks timeout 10000', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const timeouts: unknown[] = [];
    const ax = guardedAxios();
    const id = ax.interceptors.request.use((config) => {
      timeouts.push(config.timeout);
      return config;
    });
    try {
      const { fake, client } = rig({ hang: true });
      let result: TokenResult | undefined;
      void client.get('garden3d').then((r) => (result = r));
      await settle();
      expect(fake.requests).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(9_999);
      await settle();
      expect(fake.requests).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(fake.requests).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(9_999);
      await settle();
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await settle();
      expect(result).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
      watch(result!);
      expect(fake.requests).toHaveLength(2);
      expect(timeouts).toEqual([10_000, 10_000]);
    } finally {
      ax.interceptors.request.eject(id);
    }
  });
});

describe('A1.5: retry only on step 7', () => {
  const cases: Array<[string, string, number]> = [
    ['403.json', 'stacks-auth', 1],
    ['404.json', 'unknown-enterprise', 1],
    ['409.json', 'not-connected', 1],
    ['502-invalid_grant.json', 'renewal-failed:invalid_grant', 1],
    ['502-unavailable.json', 'renewal-failed:unavailable', 1],
    ['502-proxy.json', 'stacks-unreachable', 2],
  ];
  for (const [file, want, requests] of cases) {
    it(`${file}: ${want} after ${requests} request(s)`, async () => {
      const { fake, client } = rig({ byKey: { garden3d: file } });
      expect(reason(watch(await client.get('garden3d')))).toBe(want);
      expect(fake.requests).toHaveLength(requests);
    });
  }

  for (const refuse of ['refused', 'reset'] as const) {
    it(`a ${refuse} connection: stacks-unreachable after 2 requests`, async () => {
      const { fake, client } = rig({ refuse });
      expect(reason(watch(await client.get('garden3d')))).toBe('stacks-unreachable');
      expect(fake.requests).toHaveLength(2);
    });
  }

  const seconds: Array<[StacksStep, StacksStep, string]> = [
    ['502-proxy.json', '200-garden3d.json', 'token'],
    [{ refuse: 'refused' }, '200-garden3d.json', 'token'],
    ['502-proxy.json', '409.json', 'not-connected'],
    ['502-proxy.json', '403.json', 'stacks-auth'],
  ];
  for (const [first, second, want] of seconds) {
    it(`${JSON.stringify(first)} then ${second}: the second answer read by the same steps, ${want}, after 2 requests`, async () => {
      const { fake, client } = rig({ sequence: [first, second] });
      expect(reason(watch(await client.get('garden3d')))).toBe(want);
      expect(fake.requests).toHaveLength(2);
    });
  }
});

describe('T5-1: only a transport failure is step 7; any other throw is fork-error, asked once', () => {
  /** A table whose every request fails at the connection with `code` (the adapter wraps it in an AxiosError). */
  const failing = (code: string): StubTable => () => Promise.reject(Object.assign(new Error(`connect ${code}`), { code }));
  const TRANSPORT = [
    'ECONNABORTED', 'ETIMEDOUT', 'ERR_SOCKET_CONNECTION_TIMEOUT',
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENOTCONN', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN',
    'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL',
    'ERR_BAD_RESPONSE', 'Z_DATA_ERROR', 'Z_BUF_ERROR',
    'EPROTO', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_HANDSHAKE_TIMEOUT', 'ERR_SSL_WRONG_VERSION_NUMBER',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_CRL', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECRYPT_CRL_SIGNATURE',
    'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'CERT_SIGNATURE_FAILURE', 'CRL_SIGNATURE_FAILURE', 'CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED',
    'CRL_NOT_YET_VALID', 'CRL_HAS_EXPIRED', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD',
    'ERROR_IN_CRL_LAST_UPDATE_FIELD', 'ERROR_IN_CRL_NEXT_UPDATE_FIELD', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'CERT_REVOKED', 'INVALID_CA',
    'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'HOSTNAME_MISMATCH',
    // Node's HTTP parser, by prefix: garbage in place of a status line, a bad chunk size, and a code no list names.
    'HPE_INVALID_CONSTANT', 'HPE_INVALID_CHUNK_SIZE', 'HPE_SOMETHING_NEW',
  ];

  for (const code of TRANSPORT) {
    it(`a transport failure ${code}: stacks-unreachable after two requests`, async () => {
      const { client } = rig({});
      table = failing(code);
      expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
      expect(net.calls).toHaveLength(2);
    });
  }

  // HPE without its underscore, and HPE_ not at the start: neither is the parser's prefix.
  for (const code of ['ERR_BAD_REQUEST', 'ERR_SOMETHING_ELSE', 'HPE', 'X_HPE_INVALID_CONSTANT']) {
    it(`a connection failure with an unlisted code ${code}: fork-error after one request`, async () => {
      const { client, realms } = rig({});
      table = failing(code);
      expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
      expect(net.calls).toHaveLength(1);
      expect(realms.refused('garden3d')).toBeUndefined();
    });
  }

  it('a guard refusal (the company outside the guard’s keys): fork-error, asked once, one refusal line, no request reaches Stacks, nothing refused', async () => {
    restoreGuard();
    restoreGuard = startTestGuard({ stacksUrl: STACKS, keys: ['usb-club'] });
    const { fake, client, realms } = rig({});
    expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(fake.requests).toHaveLength(0);
    expect(net.calls).toHaveLength(0);
    expect(stderr.filter((s) => s.startsWith('qbo-guard: refused'))).toEqual(['qbo-guard: refused GET https://stacks.example.test/api/qbo/access_token (stacks)\n']);
    expect(realms.refused('garden3d')).toBeUndefined();
    // The company is not refused: once the guard allows it, the next call succeeds.
    expect(reason(await client.get('usb-club'))).toBe('token');
  });

  it('an answer that isn’t HTTP (garbage where the status line goes, as Node’s parser reports it): stacks-unreachable after two attempts', async () => {
    // The stub replaces the socket, so the parser's error is given as Node raises it on the request.
    const { client } = rig({});
    table = () => Promise.reject(Object.assign(new Error('Parse Error: Expected HTTP/, RTSP/ or ICE/'), { code: 'HPE_INVALID_CONSTANT', bytesParsed: 0 }));
    expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
    expect(net.calls).toHaveLength(2);
  });

  for (const [label, thrown] of [
    ['a TypeError', () => new TypeError('broken')],
    ['an Error carrying a transport code but not from axios', () => Object.assign(new Error('x'), { code: 'ECONNRESET' })],
    ['a thrown null (T5-2-3)', () => null],
    ['a thrown undefined', () => undefined],
    ['a thrown string', () => 'ECONNRESET'],
  ] as const) {
    it(`a non-transport throw (${label}): fork-error, asked once, no request`, async () => {
      const ax = guardedAxios();
      let asked = 0;
      const id = ax.interceptors.request.use(() => {
        asked++;
        throw thrown();
      });
      try {
        const { fake, client } = rig({});
        expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
        expect([asked, fake.requests.length]).toEqual([1, 0]);
      } finally {
        ax.interceptors.request.eject(id);
      }
    });
  }
});

describe('T5-6: the fake’s hang and reset sequence steps', () => {
  it('502-proxy then a hang step: stacks-unreachable at 10 s, after two requests', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const { fake, client } = rig({ sequence: ['502-proxy.json', { hang: true }] });
    let result: TokenResult | undefined;
    void client.get('garden3d').then((r) => (result = r));
    await settle();
    expect([fake.requests.length, result]).toEqual([2, undefined]);
    await jest.advanceTimersByTimeAsync(9_999);
    await settle();
    expect(result).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await settle();
    expect(result).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
    watch(result!);
    expect(fake.requests).toHaveLength(2);
  });

  it('a reset step then 200: the token, after two requests', async () => {
    const { fake, client } = rig({ sequence: [{ refuse: 'reset' }, '200-garden3d.json'] });
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(2);
  });
});

describe('A1.6: every row of the mapping, each conjunct its own case', () => {
  const name300 = 'garden3d, LLC' + ' '.repeat(190) + 'X';
  // Step 2: a 200 failing one conjunct of step 1 → fork-error, one request, nothing kept.
  const forkErrors: Array<[string, unknown, number?]> = [
    ['a sixth key (refresh_token, A1.7)', body({ refresh_token: ['r', 't'].join('-') })],
    ['a missing key', body({ company_name: undefined })],
    ['a non-JSON body', 'not json'],
    ['an empty body', ''],
    ['enterprise not the asked key', body({ enterprise: 'usb-club' })],
    ['realm_id not digits', body({ realm_id: '99900000000000a2' })],
    ['realm_id empty (T4-5)', body({ realm_id: '' })],
    ['realm_id of 21 digits', body({ realm_id: '9'.repeat(21) })],
    ['realm_id a JSON number', body({ realm_id: 42 })],
    ['empty access_token', body({ access_token: '' })],
    ['access_token a number', body({ access_token: 7 })],
    ['expires_at malformed (a space)', body({ expires_at: '2026-11-18 12:00:00Z' })],
    ['expires_at with milliseconds', body({ expires_at: '2026-11-18T12:00:00.000Z' })],
    ['expires_at an array of a good one', body({ expires_at: [EXPIRES] })],
    ['expires_at an expanded year (a real, later time that round-trips, but not the pattern)', body({ expires_at: '+010000-01-01T00:00:00Z' })],
    ['expires_at 2026-02-30T12:00:00Z (rolled by Date.parse), now before it', body({ expires_at: '2026-02-30T12:00:00Z' }), Date.parse('2026-01-01T00:00:00Z')],
    ['expires_at month 13 (Date.parse NaN)', body({ expires_at: '2026-13-01T00:00:00Z' }), Date.parse('2026-01-01T00:00:00Z')],
    ['expires_at past', body({ expires_at: '2026-11-18T11:00:00Z' })],
    ['expires_at equal to now', body(), EXPIRES_MS],
    ['company_name of only spaces', body({ company_name: '   ' })],
    ['company_name of only control characters', body({ company_name: '\t\u0007\n' })],
    ['company_name of only no-break spaces', body({ company_name: NBSP + IDEO + BOM })],
    ['company_name a number', body({ company_name: 5 })],
    ['a JSON array body', []],
    ['a JSON null body', null],
  ];
  for (const [label, b, now] of forkErrors) {
    it(`200, ${label} → fork-error, not retried, nothing kept`, async () => {
      const { fake, client, realms } = rig({ sequence: [ok200(b)] }, { now });
      expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
      expect(fake.requests).toHaveLength(1);
      expect([realms.kept('garden3d'), realms.refused('garden3d')]).toEqual([undefined, undefined]);
    });
  }

  const tokens: Array<[string, unknown, number?]> = [
    ['realm_id of 20 digits', body({ realm_id: '9'.repeat(20) })],
    ['realm_id of 1 digit', body({ realm_id: '7' })],
    ['expires_at one second after now', body(), EXPIRES_MS - 1000],
    ['company_name padded with control characters', body({ company_name: '\tgarden3d, LLC\n' })],
  ];
  for (const [label, b, now] of tokens) {
    it(`200, ${label} → token`, async () => {
      const { client } = rig({ sequence: [ok200(b)] }, { now });
      expect(reason(await client.get('garden3d'))).toBe('token');
    });
  }

  it('200 with every conjunct, the name as read decides: a name whose first 200 code points match but whose whole does not is name-mismatch', async () => {
    const { client, realms } = rig({ sequence: [ok200(body({ company_name: name300 }))] });
    expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'name-mismatch', source: 'stacks', reported: 'garden3d, LLC' } });
    expect(realms.kept('garden3d')).toBeUndefined();
  });

  const forbidden = { title: 'Unauthorized', status: 'forbidden', source: null, detail: 'x' };
  // Steps 3-7: an answer no row 3-6 takes → stacks-unreachable after two requests.
  const unreachable: Array<[string, StacksStep]> = [
    ['403 whose first error item’s status isn’t forbidden', { status: 403, body: { errors: [{ ...forbidden, status: 'denied' }] } }],
    ['403 whose second item is forbidden but not the first', { status: 403, body: { errors: [{ status: 'denied' }, forbidden] } }],
    ['403 with an empty errors array', { status: 403, body: { errors: [] } }],
    ['403 whose first error item is null', { status: 403, body: { errors: [null] } }],
    ['403 whose errors is an object, not an array', { status: 403, body: { errors: { 0: forbidden } } }],
    ['403 with a null body', { status: 403, body: null }],
    ['403 HTML', { status: 403, body: '<html>403</html>' }],
    ['404 with an added key', { status: 404, body: { error: 'unknown-enterprise', detail: 'x' } }],
    ['404 with another error', { status: 404, body: { error: 'not-connected' } }],
    ['404 HTML (a wrong STACKS_QBO_URL)', { status: 404, body: '<html>404</html>' }],
    ['404 with a null body', { status: 404, body: null }],
    ['409 with an added key', { status: 409, body: { error: 'not-connected', detail: 'x' } }],
    ['409 with another error', { status: 409, body: { error: 'unknown-enterprise' } }],
    ['409 with a null body', { status: 409, body: null }],
    ['502 whose code is 65 characters', { status: 502, body: { error: 'renewal-failed', code: 'a'.repeat(65) } }],
    ['502 whose code holds a space', { status: 502, body: { error: 'renewal-failed', code: 'invalid grant' } }],
    ['502 whose code is empty', { status: 502, body: { error: 'renewal-failed', code: '' } }],
    ['502 whose code is a number', { status: 502, body: { error: 'renewal-failed', code: 5 } }],
    ['502 with a third key', { status: 502, body: { error: 'renewal-failed', code: 'unavailable', detail: 'x' } }],
    ['502 with no code', { status: 502, body: { error: 'renewal-failed' } }],
    ['502 with another error', { status: 502, body: { error: 'failed', code: 'unavailable' } }],
    ['502 with a null body', { status: 502, body: null }],
    ['a 302', { status: 302, headers: { location: 'https://stacks.example.test/elsewhere' }, body: '' }],
    ['a 418', { status: 418, body: '' }],
    ['a 201 with a token body', { status: 201, body: body() }],
    ['a 404 carrying 409’s body', { status: 404, body: { error: 'not-connected' } }],
    ['a 409 carrying 404’s body', { status: 409, body: { error: 'unknown-enterprise' } }],
    ['a 500 carrying 403’s body', { status: 500, body: { errors: [forbidden] } }],
    ['a 500 carrying 404’s body', { status: 500, body: { error: 'unknown-enterprise' } }],
    ['a 500 carrying 409’s body', { status: 500, body: { error: 'not-connected' } }],
    ['a 500 carrying 502’s body', { status: 500, body: { error: 'renewal-failed', code: 'unavailable' } }],
  ];
  for (const [label, step] of unreachable) {
    it(`${label} → stacks-unreachable after two requests`, async () => {
      const { fake, client, realms } = rig({ sequence: [step] });
      expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
      expect(fake.requests).toHaveLength(2);
      expect(realms.refused('garden3d')).toBeUndefined();
    });
  }

  it('a 502 whose code is 64 characters → renewal-failed:<code>, one request', async () => {
    const code = 'a'.repeat(64);
    const { fake, client } = rig({ sequence: [{ status: 502, body: { error: 'renewal-failed', code } }] });
    expect(reason(watch(await client.get('garden3d')))).toBe(`renewal-failed:${code}`);
    expect(fake.requests).toHaveLength(1);
  });

  for (const [status, headers] of [[401, {}], [429, { 'retry-after': '30' }]] as const) {
    it(`a Stacks ${status}${status === 429 ? ' with Retry-After: 30' : ''}: stacks-unreachable after two requests sent at once, no forced refetch, no Authorization`, async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
      const { fake, client } = rig({ sequence: [{ status, headers, body: { error: 'x' } }] });
      let result: TokenResult | undefined;
      void client.get('garden3d').then((r) => (result = r));
      await settle(); // no timer advanced: nothing waits
      expect(result).toEqual({ ok: false, failure: { reason: 'stacks-unreachable' } });
      watch(result!);
      expect(fake.requests).toHaveLength(2);
      for (const call of fake.requests) {
        expect(header(call, 'authorization')).toBeUndefined();
        expect(header(call, 'x-api-key')).toBe(KEY);
      }
    });
  }

});

describe('A1.7: the cache holds exactly the four fields', () => {
  it('the kept token’s keys are access_token, realm_id, expires_at, company_name, and a reuse returns that entry', async () => {
    const { client } = rig({});
    const first = await client.get('garden3d');
    const again = await client.get('garden3d');
    expect(first.ok).toBe(true);
    const token = first.ok ? first.token : undefined;
    expect(Object.keys(token!).sort()).toEqual(['access_token', 'company_name', 'expires_at', 'realm_id']);
    expect(again.ok && again.token).toBe(token);
    expect(Object.isFrozen(token)).toBe(true);
  });
});

describe('A2.2, A2.6: Stacks’ name, checked at every fetch', () => {
  it('Garden Three LLC → name-mismatch, source stacks, no token kept and no realm kept; the next call fetches again and succeeds', async () => {
    const { fake, client, realms } = rig({ sequence: [ok200(body({ company_name: 'Garden Three LLC' })), ok200(body())] });
    expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'name-mismatch', source: 'stacks', reported: 'Garden Three LLC' } });
    expect(realms.kept('garden3d')).toBeUndefined();
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(2);
    expect(realms.kept('garden3d')).toBe(REALM);
  });

  it('with entities-two (Garden Three LLC accepted) the same answer succeeds', async () => {
    const { client } = rig({ sequence: [ok200(body({ company_name: 'Garden Three LLC' }))] }, { cfg: cfgOf(STACKS, COMPANIES_TWO) });
    expect(reason(await client.get('garden3d'))).toBe('token');
  });

  it('a name mismatched after a token was kept: the kept token is not used for that answer, and the next call checks again', async () => {
    const { fake, client, clock } = rig({ sequence: [ok200(body()), ok200(body({ company_name: 'Garden Three LLC' })), ok200(body())] });
    expect(reason(await client.get('garden3d'))).toBe('token');
    clock.now = EXPIRES_MS - 5 * MIN;
    expect(reason(watch(await client.get('garden3d')))).toBe('name-mismatch');
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(fake.requests).toHaveLength(3);
  });

  it('the 300-character `Garden Three\\nreason: ok` gives one cleaned reported: of at most 200 code points', async () => {
    const raw = ('Garden Three\nreason: ok' + 'x'.repeat(300)).slice(0, 300);
    expect(raw).toHaveLength(300);
    const { client } = rig({ sequence: [ok200(body({ company_name: raw }))] });
    const r = watch(await client.get('garden3d'));
    expect(r.ok).toBe(false);
    const f = (r as { failure: Failure }).failure;
    expect([f.reason, f.source]).toEqual(['name-mismatch', 'stacks']);
    expect(f.reported).toBe(cleanName(raw));
    expect(f.reported).toBe(('Garden Three reason: ok' + 'x'.repeat(300)).slice(0, 200));
    expect(Array.from(f.reported!).length).toBeLessThanOrEqual(200);
    expect(/[\p{Cc}\u2028\u2029]/u.test(f.reported!)).toBe(false);
    expect(f.reported).toBe(f.reported!.trim());
  });

  for (const [label, c] of [['U+00A0', NBSP], ['U+3000', IDEO], ['U+FEFF', BOM]] as const) {
    it(`a name with ${label} at each end is trimmed on reported: (T2-1)`, async () => {
      const { client } = rig({ sequence: [ok200(body({ company_name: `${c}Garden Three Holdings${c}` }))] });
      expect(watch(await client.get('garden3d'))).toEqual({ ok: false, failure: { reason: 'name-mismatch', source: 'stacks', reported: 'Garden Three Holdings' } });
    });
  }
});

describe('A3.6: the realm is kept only after the Stacks name check passes', () => {
  it('(a) a kept realm, then a 200 with another realm: fork-error, the company refused with no further request, others still work', async () => {
    const { fake, client, realms } = rig({ sequence: ['200-garden3d.json', ok200(body({ realm_id: REALM_OTHER }))] });
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(realms.kept('garden3d')).toBe(REALM);
    expect(watch(await client.get('garden3d', { force: true }))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(realms.refused('garden3d')).toEqual({ reason: 'fork-error' });
    expect(fake.requests).toHaveLength(2);
    expect(reason(watch(await client.get('garden3d')))).toBe('fork-error');
    expect(reason(watch(await client.get('garden3d', { force: true })))).toBe('fork-error');
    expect(fake.requests).toHaveLength(2);
    expect(realms.kept('garden3d')).toBe(REALM);
    table = stacksFake({}).handler;
    const usb = await client.get('usb-club');
    expect(usb.ok && usb.token.realm_id).toBe('9990000000000004');
    expect(net.calls.every((c) => c.hostname === HOST)).toBe(true);
  });

  it('a refused company answers its kept failure with no request, whatever refused it', async () => {
    const realms = createRealmStore();
    const kept = { reason: 'name-mismatch', source: 'quickbooks' as const, reported: 'Other Co' };
    realms.refuse('garden3d', kept);
    const { fake, client } = rig({}, { realms });
    const r = await client.get('garden3d');
    expect(r).toEqual({ ok: false, failure: kept });
    expect((r as { failure: Failure }).failure).toBe(kept);
    expect(fake.requests).toHaveLength(0);
  });

  it('(b) a first token with a bad name keeps nothing; a second with another realm and a good name is kept; a third with the first realm is fork-error', async () => {
    const { client, realms } = rig({
      sequence: [ok200(body({ company_name: 'Garden Three Holdings' })), ok200(body({ realm_id: REALM_OTHER })), ok200(body())],
    });
    expect(reason(watch(await client.get('garden3d')))).toBe('name-mismatch');
    expect(realms.kept('garden3d')).toBeUndefined();
    const second = await client.get('garden3d');
    expect(second.ok && second.token.realm_id).toBe(REALM_OTHER);
    expect(realms.kept('garden3d')).toBe(REALM_OTHER);
    expect(reason(watch(await client.get('garden3d', { force: true })))).toBe('fork-error');
    expect(realms.refused('garden3d')).toEqual({ reason: 'fork-error' });
    expect(realms.kept('garden3d')).toBe(REALM_OTHER);
  });

  it('(c) a changed realm with a bad name, after a realm is kept: fork-error (step 2 before the name check), refused until restart', async () => {
    const { fake, client, realms } = rig({ sequence: [ok200(body()), ok200(body({ realm_id: REALM_OTHER, company_name: 'Garden Three Holdings' }))] });
    await client.get('garden3d');
    expect(watch(await client.get('garden3d', { force: true }))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(realms.refused('garden3d')).toEqual({ reason: 'fork-error' });
    expect(reason(await client.get('garden3d'))).toBe('fork-error');
    expect(fake.requests).toHaveLength(2);
  });

  it('a changed realm decides in step 1’s order, before access_token and expires_at: fork-error and refused', async () => {
    const { client, realms } = rig({ sequence: [ok200(body()), ok200(body({ realm_id: REALM_OTHER, access_token: '', expires_at: '2026-11-18T11:00:00Z' }))] });
    await client.get('garden3d');
    expect(reason(watch(await client.get('garden3d', { force: true })))).toBe('fork-error');
    expect(realms.refused('garden3d')).toEqual({ reason: 'fork-error' });
  });

  it('a malformed realm after a realm is kept is fork-error but does not refuse', async () => {
    const { client, realms } = rig({ sequence: [ok200(body()), ok200(body({ realm_id: '' })), ok200(body())] });
    await client.get('garden3d');
    expect(reason(watch(await client.get('garden3d', { force: true })))).toBe('fork-error');
    expect(realms.refused('garden3d')).toBeUndefined();
    expect(reason(await client.get('garden3d'))).toBe('token');
  });

  it('the same realm again is a token, and the kept realm stays', async () => {
    const { client, realms } = rig({ sequence: [ok200(body()), ok200(body({ access_token: ACCESS_B }))] });
    await client.get('garden3d');
    const r = await client.get('garden3d', { force: true });
    expect(r.ok && r.token.access_token).toBe(ACCESS_B);
    expect(realms.kept('garden3d')).toBe(REALM);
  });

  it('realms.keep is called only when no realm is kept: once over two fetches (T5-2)', async () => {
    const inner = createRealmStore();
    const keeps: Array<[string, string]> = [];
    const realms: RealmStore = { ...inner, keep: (c, r) => (keeps.push([c, r]), inner.keep(c, r)) };
    const { fake, client } = rig({ sequence: [ok200(body()), ok200(body({ access_token: ACCESS_B }))] }, { realms });
    expect(reason(await client.get('garden3d'))).toBe('token');
    expect(reason(await client.get('garden3d', { force: true }))).toBe('token');
    expect(fake.requests).toHaveLength(2);
    expect(keeps).toEqual([['garden3d', REALM]]);
  });

  it('a kept realm, then another realm with a sixth key: plain fork-error, nothing refused, the next good reply accepted (T5-4)', async () => {
    const { client, realms } = rig({ sequence: [ok200(body()), ok200(body({ realm_id: REALM_OTHER, extra: 'x' })), ok200(body())] });
    await client.get('garden3d');
    expect(watch(await client.get('garden3d', { force: true }))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(realms.refused('garden3d')).toBeUndefined();
    expect(reason(await client.get('garden3d', { force: true }))).toBe('token');
    expect(realms.kept('garden3d')).toBe(REALM);
  });

  it('a kept realm, then another realm under another enterprise: plain fork-error, nothing refused (T5-2-4)', async () => {
    const { client, realms } = rig({ sequence: [ok200(body()), ok200(body({ realm_id: REALM_OTHER, enterprise: 'usb-club' })), ok200(body())] });
    await client.get('garden3d');
    expect(watch(await client.get('garden3d', { force: true }))).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    expect(realms.refused('garden3d')).toBeUndefined();
    expect(reason(await client.get('garden3d', { force: true }))).toBe('token');
    expect(realms.kept('garden3d')).toBe(REALM);
  });

  it('(d) sequences/realm-after-mismatch.json, step by step, one fetch per step', async () => {
    const seq = JSON.parse(readFileSync(fakes('sequences/realm-after-mismatch.json'), 'utf8')) as {
      company: string;
      steps: Array<{ answer: StacksStep; expected: string; kept_realm: string | null }>;
    };
    const { fake, client, realms } = rig({ sequence: seq.steps.map((s) => s.answer) });
    for (const [i, step] of seq.steps.entries()) {
      const r = watch(await client.get(seq.company, { force: true }));
      expect(fake.requests).toHaveLength(i + 1);
      expect(reason(r)).toBe(step.expected);
      expect(realms.kept(seq.company) ?? null).toBe(step.kept_realm);
    }
  });
});

// T13: jest shares node's built-ins across the files a worker runs, so the stub and the trap are put back once this file
// is done (declared last: it runs after every other afterAll here); a later file opening a real socket gets the real ones.
afterAll(() => {
  net.restore();
  trap.restore();
});
