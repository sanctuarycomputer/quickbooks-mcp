// Sanctuary Computer (quickbooks-mcp-286): createRuntime's wiring, through the started server (spec A2.7's wiring half,
// A3.4/A3.5 through the entry's start, A6.1 rerun with the wiring; carried U1, U3, T3-1, T4-3, T6-4, TB6). Every case starts
// with tests/helpers/server.ts (291's secureStart, then 285's startReadServer, which builds the runtime); none binds
// node-quickbooks' bluebird itself, so only createRuntime's bindPromiseContext() does.
import { describe, it, expect, afterEach, afterAll, jest } from '@jest/globals';
import { z } from 'zod';
import {
  NOW,
  QBO_HOST,
  REALMS,
  STACKS_KEY,
  STACKS_URL,
  fixtureToken,
  installNetwork,
  readTools,
  startServer,
  testEnv,
  textOf,
  type Rig,
  type StartOpts,
} from '../../helpers/server.js';
import type { StubCall, StubAnswer } from '../../fakes/stub-network.js';
import { guardedAxios } from '../../../src/http-guard.js';
import { clearFailure, currentCall } from '../../../src/clients/call-context.js';
import { QuickbooksClient } from '../../../src/clients/quickbooks-client.js';
import { REFUSED_KEYS, type ReadTool } from '../../../src/allowlist.js';
import { runInCall } from '../../../src/clients/call-context.js';
import { createRuntime } from '../../../src/clients/runtime.js';

const network = installNetwork();
const { net } = network;

let rigs: Rig[] = [];
async function start(opts: StartOpts = {}): Promise<Rig> {
  const r = await startServer(opts);
  rigs.push(r);
  return r;
}
let stderr: string[] = [];
afterEach(async () => {
  for (const r of rigs) await r.close();
  rigs = [];
  net.calls.length = 0;
  stderr = [];
});
afterAll(() => {
  expect(network.trap.reached).toEqual([]);
  network.restore();
});
const captureStderr = () =>
  jest.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr.push(String(chunk));
    return true;
  }) as any);

// Built at runtime: no secret-shaped literal sits in this file.
const access = (k: string) => ['qbo', 'test', 'access', k].join('-');
const tokenBody = (token: string, company = 'garden3d') => ({
  status: 200,
  body: { enterprise: company, realm_id: REALMS[company], access_token: token, expires_at: '2026-11-18T12:00:00Z', company_name: company === 'garden3d' ? 'garden3d, LLC' : 'USB Club, LLC' },
});
const BILL_ARGS = { params: { criteria: [{ field: 'Id', value: '1' }], limit: 10 } };
const isQuery = (c: StubCall) => c.hostname === QBO_HOST && (c.path ?? '').includes('/query?');
const isInfo = (c: StubCall) => c.hostname === QBO_HOST && (c.path ?? '').includes('/companyinfo/');
const bearer = (c: StubCall) => String((c.headers as Record<string, unknown>)?.Authorization ?? (c.headers as Record<string, unknown>)?.authorization);
const json = (status: number, body: unknown, headers: Record<string, string> = {}): StubAnswer => ({ status, headers, body: JSON.stringify(body) });
const interceptorCount = () => {
  const ax = guardedAxios() as unknown as { interceptors: Record<'request' | 'response', { handlers: unknown[] }> };
  return ax.interceptors.request.handlers.filter(Boolean).length + ax.interceptors.response.handlers.filter(Boolean).length;
};

/** The tool list with `name` (a report-free `other` tool by default) answered by `handler`. */
async function withHandler(handler: () => Promise<unknown>, name = 'get_preferences'): Promise<ReadTool[]> {
  return (await readTools()).map((t) => (t.name === name ? ({ name, description: 'd', schema: z.object({}), handler } as unknown as ReadTool) : t));
}

/** Each fetchAllBills callback: the company of the call that asked, and of the call whose store the callback ran in. */
const callbacks: Array<{ asked: string | undefined; ranIn: string | undefined }> = [];
/**
 * A search handler over node-quickbooks' own fetchAll: findBills pages by `limit`, its next page asked from a bluebird
 * handler, and its callback run from bluebird's queue (module.query's outer promise is settled later, so bluebird runs its
 * handlers from one shared drain). The callback notes the call it ran in.
 */
const fetchAllBills = async () => {
  const qb: any = await QuickbooksClient.getInstance();
  const asked = currentCall()?.company;
  const rows = await new Promise((resolve, reject) =>
    qb.findBills({ fetchAll: true, limit: 2 }, (err: unknown, data: any) => {
      callbacks.push({ asked, ranIn: currentCall()?.company });
      return err ? reject(new Error('find failed')) : resolve(data.QueryResponse.Bill);
    }),
  );
  return { content: [{ type: 'text', text: 'Bills:' }, { type: 'text', text: JSON.stringify(rows) }] };
};
const THREE = [{ Id: '1' }, { Id: '2' }, { Id: '3' }];

describe('the wiring: realm store, Stacks client, company state, guard callbacks, interceptors', () => {
  it("a call: Stacks asked with the key for the call's company, companyinfo read, the tool's request with the company's token and realm", async () => {
    const { client } = await start({ qbo: { rows: [{ Id: '1' }] } });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('{"Id":"1","depth":0}');
    const [stacks, info, query, ...rest] = net.calls;
    expect(rest).toEqual([]);
    expect(stacks.hostname).toBe('stacks.example.test');
    expect(stacks.path).toBe('/api/qbo/access_token?enterprise=garden3d');
    expect((stacks.headers as Record<string, unknown>)['X-Api-Key']).toBe(STACKS_KEY);
    for (const c of [info, query]) {
      expect(c.path?.startsWith(`/v3/company/${REALMS.garden3d}/`)).toBe(true);
      expect(bearer(c)).toBe(`Bearer ${fixtureToken('garden3d')}`);
    }
    expect(isInfo(info) && isQuery(query)).toBe(true);
  });

  it("the guard's keys are the loaded ones: inside a call a Stacks request for another key is refused, the company's own sent", async () => {
    captureStderr();
    const outcomes: Record<string, unknown> = {};
    const probe = async () => {
      for (const key of ['north-fork', 'garden3d']) {
        try {
          const res = await guardedAxios()({ method: 'get', url: `${STACKS_URL}/api/qbo/access_token?enterprise=${key}`, validateStatus: () => true });
          outcomes[key] = res.status;
        } catch (e) {
          outcomes[key] = (e as Error).name;
        }
        clearFailure();
      }
      currentCall()!.failure = null;
      return { content: [{ type: 'text', text: '{}' }] };
    };
    const { client } = await start({ tools: await withHandler(probe) });
    await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    expect(outcomes).toEqual({ 'north-fork': 'GuardRefusedError', garden3d: 200 });
    expect(stderr.join('')).toContain('qbo-guard: refused GET https://stacks.example.test/api/qbo/access_token (stacks)');
  });

  it("the guard's realm is the call's: inside a garden3d call a request to usb-club's realm is refused, nothing sent", async () => {
    captureStderr();
    let outcome: unknown;
    const probe = async () => {
      const usb = REALMS['usb-club'];
      try {
        await guardedAxios()({ method: 'get', url: `https://${QBO_HOST}/v3/company/${usb}/companyinfo/${usb}?minorversion=75&format=json` });
      } catch (e) {
        outcome = (e as Error).name;
      }
      return { content: [{ type: 'text', text: '{}' }] };
    };
    const { client } = await start({ tools: await withHandler(probe) });
    const r = await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    expect(outcome).toBe('GuardRefusedError');
    expect(textOf(r)).toBe('reason: fork-error\n\nThe server failed before it could read QuickBooks.');
    expect(net.calls.filter((c) => c.path?.includes(REALMS['usb-club']))).toEqual([]);
  });

  it("the secrets: a 400 whose fault echoes STACKS_QBO_TOKEN and the call's token is redacted", async () => {
    const detail = `echo ${STACKS_KEY} and ${fixtureToken('garden3d')}`;
    const { client } = await start({
      qbo: { rows: [] },
      route: (c) => (isQuery(c) ? json(400, { Fault: { Error: [{ Message: 'Bad', Detail: detail }] } }) : undefined),
    });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('reason: http-400\n\nQuickBooks answered 400. QuickBooks said: Bad: echo [redacted] and [redacted]');
  });

  it("the secrets read the call's token when the fault is recorded: a newer token than the failed request's own is redacted too", async () => {
    // Two preferences reads in one call, both sent with token a. The first gets a 401 and is resent with b; the second's
    // 400 then arrives, its fault echoing b, the call's token by then (not the bearer that request carried).
    let releaseSecond: () => void = () => {};
    const second = new Promise<void>((resolve) => (releaseSecond = resolve));
    let reads = 0;
    let newer = '';
    const route = (c: StubCall): ReturnType<NonNullable<StartOpts['route']>> => {
      if (!(c.path ?? '').includes('/preferences?')) return undefined;
      reads++;
      if (reads === 1) return json(401, {});
      if (reads === 2) return second.then(() => json(400, { Fault: { Error: [{ Message: 'Bad', Detail: `echo ${newer}` }] } }));
      newer = bearer(c).replace('Bearer ', '');
      setTimeout(releaseSecond, 20);
      return json(200, { Preferences: {} });
    };
    const handler = async () => {
      const qb: any = await QuickbooksClient.getInstance();
      const read = () => new Promise((resolve) => qb.getPreferences((err: unknown) => resolve(err)));
      await Promise.all([read(), read()]);
      return { content: [{ type: 'text', text: '{}' }] };
    };
    const { client } = await start({ tools: await withHandler(handler), stacks: { sequence: [tokenBody(access('a')), tokenBody(access('b'))] }, route });
    const r = await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    expect(newer).toBe(access('b'));
    expect(textOf(r)).toBe('reason: http-400\n\nQuickBooks answered 400. QuickBooks said: Bad: echo [redacted]');
  });

  it("reacquire is the Stacks client's forced get: a 401 fetches a new token and the resend carries it", async () => {
    let queries = 0;
    const { client, stacks } = await start({
      qbo: { rows: [{ Id: '1' }] },
      stacks: { sequence: [tokenBody(access('a')), tokenBody(access('b'))] },
      route: (c) => (isQuery(c) && queries++ === 0 ? json(401, {}) : undefined),
    });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('{"Id":"1","depth":0}');
    expect(stacks.requests).toHaveLength(2);
    expect(net.calls.filter(isQuery).map(bearer)).toEqual([`Bearer ${access('a')}`, `Bearer ${access('b')}`]);
  });

  it("mark and sentAt (A1.3b): a 401 on a request sent after another call's forced fetch began makes its own fetch, not a join", async () => {
    // Two garden3d calls, both with token a. The first's 401 starts a forced fetch (b, held); only then does the second send
    // its request, which also gets a 401: it was sent after that fetch began, so that fetch may carry a token no newer than
    // its own, and it makes a new fetch (c) instead of joining.
    let began: () => void = () => {};
    const forcedBegan = new Promise<void>((resolve) => (began = resolve));
    let releaseB: () => void = () => {};
    const holdB = new Promise<void>((resolve) => (releaseB = resolve));
    // A mutant that joins never asks Stacks a third time; this lets it finish (and fail) instead of hanging.
    const fallback = setTimeout(() => releaseB(), 1500);
    let stacksAsked = 0;
    let queries = 0;
    const route = (c: StubCall) => {
      if (c.hostname !== QBO_HOST) {
        stacksAsked++;
        if (stacksAsked === 2) began();
        if (stacksAsked === 3) releaseB();
        return undefined;
      }
      return isQuery(c) && ++queries <= 2 ? json(401, {}) : undefined;
    };
    let invoked = 0;
    const handler = async () => {
      if (++invoked === 2) await forcedBegan;
      const qb: any = await QuickbooksClient.getInstance();
      const rows = await new Promise((resolve, reject) => qb.findBills({ Id: '1' }, (err: unknown, data: any) => (err ? reject(new Error('find failed')) : resolve(data.QueryResponse.Bill))));
      return { content: [{ type: 'text', text: 'Bills:' }, { type: 'text', text: JSON.stringify(rows) }] };
    };
    try {
      const { client, stacks } = await start({
        tools: await withHandler(handler, 'search_bills'),
        qbo: { rows: [{ Id: '1' }] },
        stacks: { sequence: [tokenBody(access('a')), { answer: tokenBody(access('b')), hold: holdB }, tokenBody(access('c'))] },
        route,
      });
      const call = () => client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: {} } });
      const results = await Promise.all([call(), call()]);
      for (const r of results) expect(textOf(r)).toBe('{"Id":"1","depth":0}');
      expect(stacks.requests).toHaveLength(3);
      expect(net.calls.filter(isQuery).map(bearer).sort()).toEqual([access('a'), access('a'), access('b'), access('c')].map((t) => `Bearer ${t}`).sort());
    } finally {
      clearTimeout(fallback);
    }
  });

  it("U3: the Stacks client reads the injected clock: at the fixtures' expires_at the token is refused", async () => {
    const { client } = await start({ now: () => Date.parse('2026-11-18T12:00:00Z') });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('reason: fork-error\n\nThe server failed before it could read QuickBooks.');
    expect(net.calls.filter((c) => c.hostname === QBO_HOST)).toEqual([]);
    expect(new Date(NOW).toISOString()).toBe('2026-11-18T11:00:00.000Z');
  });
});

describe('createRuntime without deps', () => {
  it("the Stacks client's clock is Date.now", async () => {
    const r = await start();
    const runtime = createRuntime(r.runtime.cfg);
    try {
      const get = () => runInCall('garden3d', () => runtime.stacks.get('garden3d'));
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T12:00:00Z'));
      expect(await get()).toEqual({ ok: false, failure: { reason: 'fork-error' } });
    } finally {
      runtime.close();
    }
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const fresh = createRuntime(r.runtime.cfg);
    try {
      const got = await runInCall('garden3d', () => fresh.stacks.get('garden3d'));
      expect(got.ok).toBe(true);
    } finally {
      fresh.close();
    }
  });
});

describe("close() and U1: the interceptors come off", () => {
  it('close() ejects both interceptors', async () => {
    const r = await start();
    const running = interceptorCount();
    r.runtime.close();
    expect(interceptorCount()).toBe(running - 2);
  });

  it('a start that fails after createRuntime (a missing tool) closes the runtime and registers nothing', async () => {
    const before = interceptorCount();
    const tools = (await readTools()).filter((t) => t.name !== 'search_vendors');
    await expect(startServer({ tools })).rejects.toThrow(new Error('refused to start: allowlist: missing search_vendors'));
    expect(interceptorCount()).toBe(before);
  });
});

describe('T3-1: secureStart and loadConfig read STACKS_QBO_URL alike', () => {
  it.each([
    ['http', 'http://stacks.example.test', 'is not https'],
    ['a path', 'https://stacks.example.test/api', 'has a path'],
    ['a query', 'https://stacks.example.test/?x=1', 'has a query or fragment'],
    ['a bare ?', 'https://stacks.example.test/?', 'has a query or fragment'],
    ['a fragment', 'https://stacks.example.test#f', 'has a query or fragment'],
    ['a username', 'https://u@stacks.example.test', 'has a username'],
    ['a password', 'https://:p@stacks.example.test', 'has a password'],
    ['not a URL', 'stacks.example.test', 'is not a URL'],
    ['empty', '', 'is empty'],
  ])('a URL loadConfig refuses (%s) never starts the server, so the guard never pins it for a tool', async (_label, url, reason) => {
    const before = interceptorCount();
    await expect(startServer({ env: testEnv({ STACKS_QBO_URL: url }) })).rejects.toThrow(new Error(`refused to start: STACKS_QBO_URL ${reason}`));
    expect(interceptorCount()).toBe(before);
    expect(net.calls).toEqual([]);
  });

  it.each([
    ['a trailing /', 'https://stacks.example.test/', 'stacks.example.test', '443'],
    ['upper case', 'https://STACKS.Example.TEST', 'stacks.example.test', '443'],
    ['the default port', 'https://stacks.example.test:443', 'stacks.example.test', '443'],
    ['another port', 'https://stacks.example.test:8443', 'stacks.example.test', '8443'],
  ])('an accepted URL (%s): the origin the guard allows is the one the client sends to', async (_label, url, host, port) => {
    captureStderr();
    const { client } = await start({ env: testEnv({ STACKS_QBO_URL: url }), qbo: { rows: [{ Id: '1' }] } });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('{"Id":"1","depth":0}');
    expect(net.calls[0].hostname).toBe(host);
    expect(String(net.calls[0].port)).toBe(port);
    expect(stderr).toEqual([]);
  });
});

/**
 * Every QuickBooks request as it reaches the guard (a request interceptor added after the runtime's, so it runs first):
 * the company of the call whose store it runs in, the realm in its URL, its page and its bearer. 291's guard then decides it.
 */
function watchRequests(): { seen: Array<{ company: string | undefined; realm: string; start: string; bearer: string }>; eject(): void } {
  const seen: Array<{ company: string | undefined; realm: string; start: string; bearer: string }> = [];
  const ax = guardedAxios() as any;
  const id = ax.interceptors.request.use((config: any) => {
    const url = new URL(String(config.url));
    if (url.hostname === QBO_HOST && url.pathname.endsWith('/query')) {
      const start = /startposition (\d+)/i.exec(String(config.params?.query ?? url.searchParams.get('query')))?.[1] ?? '?';
      seen.push({ company: currentCall()?.company, realm: url.pathname.split('/')[3], start, bearer: String(config.headers?.Authorization) });
    }
    return config;
  });
  return { seen, eject: () => ax.interceptors.request.eject(id) };
}
/** The guard's refusal lines for QuickBooks queries. */
const queryRefusals = () => stderr.filter((l) => l.startsWith('qbo-guard: refused GET https://quickbooks.api.intuit.com/'));

// node-quickbooks' fetchAll asks its next page from inside a bluebird handler. Contract §6's one query per entity per
// call (D8) refuses that page at the guard, in the call it belongs to; so these cases read the page where it reaches the
// guard, not at the stub.
describe("T4-3: createRuntime binds node-quickbooks' bluebird before any call", () => {
  it("two overlapping calls for different companies through fetchAll: each next page is asked in its own call and refused there by D8", async () => {
    captureStderr();
    callbacks.length = 0;
    const rig = await start({ tools: await withHandler(fetchAllBills, 'search_bills'), qbo: { rows: THREE } });
    const watch = watchRequests();
    // Both first pages' answers are handed on together, once both arrived, so both calls' node-quickbooks promises
    // settle in one microtask run and their bluebird handlers share one drain (bluebird schedules it on process.nextTick).
    const ax = guardedAxios() as any;
    let open: () => void = () => {};
    const both = new Promise<void>((resolve) => (open = resolve));
    let firstPages = 0;
    const gate = ax.interceptors.response.use(async (response: any) => {
      if (!/startposition 1 /i.test(String(response.config?.params?.query ?? decodeURIComponent(String(response.config?.url)).replace(/\+/g, ' ')))) return response;
      if (++firstPages === 2) open();
      await both;
      return response;
    });
    try {
      const call = (company: string) => rig.client.callTool({ name: 'search_bills', arguments: { company, params: {} } });
      const results = await Promise.all([call('garden3d'), call('usb-club')]);
      for (const r of results) expect(textOf(r)).toBe('reason: fork-error\n\nThe server failed before it could read QuickBooks.');
    } finally {
      watch.eject();
      ax.interceptors.response.eject(gate);
    }
    expect(firstPages).toBe(2);
    // Both callbacks ran from one bluebird drain; each in the call that asked.
    expect(callbacks.map((c) => c.asked).sort()).toEqual(['garden3d', 'usb-club']);
    for (const c of callbacks) expect(c.ranIn).toBe(c.asked);
    const byRealm = Object.fromEntries(Object.entries(REALMS).map(([k, v]) => [v, k]));
    expect(watch.seen.map((q) => q.start).sort()).toEqual(['1', '1', '3', '3']);
    for (const q of watch.seen) {
      expect(q.company).toBe(byRealm[q.realm]);
      expect(q.bearer).toBe(`Bearer ${fixtureToken(q.company!)}`);
    }
    // Each next page reached the guard in its own call: its realm allowed, refused by the query rule only.
    expect(queryRefusals().sort()).toEqual(
      [REALMS.garden3d, REALMS['usb-club']].map((realm) => `qbo-guard: refused GET https://quickbooks.api.intuit.com/v3/company/${realm}/query (query)\n`).sort(),
    );
    expect(net.calls.filter(isQuery)).toHaveLength(2);
  });
});

describe("T6-4: inside a call each request reads the call's token when it is sent", () => {
  it("fetchAll after the first page's 401 resend: the next page is asked with the new token, in its own call", async () => {
    captureStderr();
    let queries = 0;
    const route = (c: StubCall) => (isQuery(c) && queries++ === 0 ? json(401, {}) : undefined);
    const { client, stacks } = await start({
      tools: await withHandler(fetchAllBills, 'search_bills'),
      qbo: { rows: THREE },
      stacks: { sequence: [tokenBody(access('a')), tokenBody(access('b'))] },
      route,
    });
    const watch = watchRequests();
    try {
      const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', params: {} } });
      expect(textOf(r)).toBe('reason: fork-error\n\nThe server failed before it could read QuickBooks.');
    } finally {
      watch.eject();
    }
    expect(stacks.requests).toHaveLength(2);
    // The first page, its resend (sent by the interceptors, not through node-quickbooks' request), then the next page.
    expect(watch.seen.map((q) => [q.start, q.bearer, q.company])).toEqual([
      ['1', `Bearer ${access('a')}`, 'garden3d'],
      ['1', `Bearer ${access('b')}`, 'garden3d'],
      ['3', `Bearer ${access('b')}`, 'garden3d'],
    ]);
    expect(net.calls.filter(isQuery).map(bearer)).toEqual([`Bearer ${access('a')}`, `Bearer ${access('b')}`]);
    expect(queryRefusals()).toEqual([`qbo-guard: refused GET https://quickbooks.api.intuit.com/v3/company/${REALMS.garden3d}/query (query)\n`]);
  });
});

describe("T6-4's budget half: a later request runs outside the earlier one's resend lineage, with its own 401 resend", () => {
  it('findBills (401, resent with b), then getPreferences (401, resent with c): the data, Stacks asked three times, bearers a, b, b, c', async () => {
    let queries = 0;
    let prefs = 0;
    const isPrefs = (c: StubCall) => c.hostname === QBO_HOST && (c.path ?? '').includes('/preferences?');
    const route = (c: StubCall) => {
      if (isQuery(c) && queries++ === 0) return json(401, {});
      if (isPrefs(c)) return prefs++ === 0 ? json(401, {}) : json(200, { Preferences: {} });
      return undefined;
    };
    const handler = async () => {
      const qb: any = await QuickbooksClient.getInstance();
      const bills = await new Promise((resolve, reject) =>
        qb.findBills({ Id: '1' }, (err: unknown, data: any) => (err ? reject(new Error('find failed')) : resolve(data.QueryResponse.Bill))),
      );
      const preferences = await new Promise((resolve, reject) =>
        qb.getPreferences((err: unknown, data: any) => (err ? reject(new Error('preferences failed')) : resolve(data))),
      );
      return { content: [{ type: 'text', text: JSON.stringify({ bills, preferences: preferences !== undefined }) }] };
    };
    const { client, stacks } = await start({
      tools: await withHandler(handler),
      qbo: { rows: [{ Id: '1' }] },
      stacks: { sequence: [tokenBody(access('a')), tokenBody(access('b')), tokenBody(access('c'))] },
      route,
    });
    const r = await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    expect(textOf(r)).toBe('{"bills":[{"Id":"1"}],"preferences":true}');
    expect(stacks.requests).toHaveLength(3);
    expect(net.calls.filter((c) => isQuery(c) || isPrefs(c)).map((c) => [isQuery(c) ? 'query' : 'preferences', bearer(c)])).toEqual([
      ['query', `Bearer ${access('a')}`],
      ['query', `Bearer ${access('b')}`],
      ['preferences', `Bearer ${access('b')}`],
      ['preferences', `Bearer ${access('c')}`],
    ]);
  });
});

// T10-3: the guard counts one 401 resend per call (contract §6's per-call record), while the interceptors' budget is per
// request lineage. A call reading two entities by query, each answered 401 once, gets the first entity's resend through
// and the second's refused at the guard as (query): the call answers fork-error. No listed tool reads two entities by
// query in one call (each search reads its own entity once; the report and get tools read no query), so this is a
// built handler's case only.
describe("T10-3: a second entity's 401 resend in one call is refused by the guard's per-call count", () => {
  it('findBills (401, resent with b, the data), then findVendors (401): its resend refused as (query), never sent; fork-error', async () => {
    captureStderr();
    const isEntity = (c: StubCall, entity: string) => isQuery(c) && new RegExp(`from ${entity} `, 'i').test(decodeURIComponent(c.path ?? '').replace(/\+/g, ' '));
    const first = { bill: true, vendor: true };
    const route = (c: StubCall) => {
      for (const entity of ['bill', 'vendor'] as const) {
        if (isEntity(c, entity) && first[entity]) {
          first[entity] = false;
          return json(401, {});
        }
      }
      return undefined;
    };
    const handler = async () => {
      const qb: any = await QuickbooksClient.getInstance();
      const ask = (method: string) => new Promise((resolve, reject) => qb[method]({ Id: '1' }, (err: unknown, data: unknown) => (err ? reject(new Error(`${method} failed`)) : resolve(data))));
      await ask('findBills');
      await ask('findVendors');
      return { content: [{ type: 'text', text: '{}' }] };
    };
    const { client, stacks } = await start({
      tools: await withHandler(handler),
      qbo: { rows: [{ Id: '1' }] },
      stacks: { sequence: [tokenBody(access('a')), tokenBody(access('b')), tokenBody(access('c'))] },
      route,
    });
    const r = await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'reason: fork-error\n\nThe server failed before it could read QuickBooks.' }] });
    // On the wire: the bill query (401), its resend (the data), the vendor query (401); the vendor resend was never sent.
    expect(net.calls.filter(isQuery).map((c) => [isEntity(c, 'bill') ? 'bill' : 'vendor', bearer(c)])).toEqual([
      ['bill', `Bearer ${access('a')}`],
      ['bill', `Bearer ${access('b')}`],
      ['vendor', `Bearer ${access('b')}`],
    ]);
    // The vendor 401 did fetch a new token (c); the guard refused the resend that would have carried it.
    expect(stacks.requests).toHaveLength(3);
    expect(queryRefusals()).toEqual([`qbo-guard: refused GET https://quickbooks.api.intuit.com/v3/company/${REALMS.garden3d}/query (query)\n`]);
  });
});

describe('TB6: a handler that throws the error the interceptors rethrew', () => {
  it("answers the recorded failure; neither the result nor stderr nor the console holds the token or the key", async () => {
    captureStderr();
    const logs: string[] = [];
    for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) {
      jest.spyOn(console, m).mockImplementation(((...a: unknown[]) => void logs.push(a.map(String).join(' '))) as any);
    }
    let thrown: unknown;
    const handler = async () => {
      const realm = REALMS.garden3d;
      try {
        await guardedAxios()({
          method: 'get',
          url: `https://${QBO_HOST}/v3/company/${realm}/companyinfo/${realm}?minorversion=75&format=json`,
          headers: { Authorization: `Bearer ${currentCall()!.token}`, 'X-Echo': STACKS_KEY },
        });
      } catch (e) {
        thrown = e;
        throw e;
      }
    };
    let infos = 0;
    const route = (c: StubCall) => (isInfo(c) && infos++ === 1 ? json(500, {}, { intuit_tid: 'tid-9' }) : undefined);
    const { client } = await start({ tools: await withHandler(handler), route });
    const r = await client.callTool({ name: 'get_preferences', arguments: { company: 'garden3d', params: {} } });
    // The error carries the bearer in its config, as T6 rethrows it.
    expect(JSON.stringify((thrown as any).config.headers)).toContain(fixtureToken('garden3d'));
    expect(r).toEqual({ isError: true, content: [{ type: 'text', text: 'reason: http-500\nintuit_tid: tid-9\n\nQuickBooks answered 500.' }] });
    const seen = [JSON.stringify(r), ...stderr, ...logs].join('\n');
    expect(seen).not.toContain(fixtureToken('garden3d'));
    expect(seen).not.toContain(STACKS_KEY);
  });
});

// A6.1 rerun with the wiring: 291's start, 285's start (which now loads the config and builds the runtime), and a call.
type Trap = 'get' | 'has' | 'getOwnPropertyDescriptor' | 'ownKeys' | 'set' | 'defineProperty' | 'deleteProperty';
describe('A6.1 with the wiring: the start and a call touch only allowed keys, each of the five read', () => {
  it('secureStart, startReadServer (loadConfig, createRuntime, registration) and a tool call', async () => {
    const touched: Array<[Trap, string | symbol]> = [];
    const target = { ...testEnv(), QUICKBOOKS_DISABLE_WRITE: 'true', QUICKBOOKS_TOKEN_STORE_PATH: '/nonexistent', QBO_PDF_OUTPUT_DIR: '/nonexistent', PATH: '/usr/bin' };
    const env = new Proxy(target, {
      get: (t, k) => (touched.push(['get', k]), Reflect.get(t, k)),
      has: (t, k) => (touched.push(['has', k]), Reflect.has(t, k)),
      getOwnPropertyDescriptor: (t, k) => (touched.push(['getOwnPropertyDescriptor', k]), Reflect.getOwnPropertyDescriptor(t, k)),
      ownKeys: (t) => (touched.push(['ownKeys', '*']), Reflect.ownKeys(t)),
      set: (t, k, v) => (touched.push(['set', k]), Reflect.set(t, k, v)),
      defineProperty: (t, k, d) => (touched.push(['defineProperty', k]), Reflect.defineProperty(t, k, d)),
      deleteProperty: (t, k) => (touched.push(['deleteProperty', k]), Reflect.deleteProperty(t, k)),
    });
    const { client } = await start({ env, qbo: { rows: [{ Id: '1' }] } });
    const r = await client.callTool({ name: 'search_bills', arguments: { company: 'garden3d', ...BILL_ARGS } });
    expect(textOf(r)).toBe('{"Id":"1","depth":0}');
    const FIVE = ['STACKS_QBO_URL', 'STACKS_QBO_TOKEN', 'QUICKBOOKS_ENVIRONMENT', 'QBO_COMPANIES', 'QBO_MODE'];
    const GUARD = ['NODE_USE_ENV_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'];
    const bad: string[] = [];
    for (const [trap, key] of touched) {
      const k = String(key);
      if (trap === 'ownKeys') bad.push('ownKeys');
      else if (typeof key !== 'string' || ![...FIVE, ...GUARD, ...REFUSED_KEYS].includes(k)) bad.push(`${trap} ${k}`);
      else if (REFUSED_KEYS.includes(k) && trap === 'get') bad.push(`get ${k}`);
      else if (!['get', 'has', 'getOwnPropertyDescriptor'].includes(trap)) bad.push(`${trap} ${k}`);
    }
    expect(bad).toEqual([]);
    for (const k of FIVE) expect(touched.some(([t, key]) => t === 'get' && key === k)).toBe(true);
  });
});
