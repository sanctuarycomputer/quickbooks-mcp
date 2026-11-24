// Sanctuary Computer (quickbooks-mcp-286): the per-company state and getInstance (spec A2.3-A2.5, A2.9, A3.3, A3.5, and
// A1.3b's forced join). Every request goes through node-quickbooks' own client (QuickbooksClient.getInstance, as 285's
// handlers reach it) on 291's guarded axios, with T6's interceptors installed and a real StacksTokenClient asking the
// Stacks fake; the stub network answers below the guard.
import { describe, it as jestIt, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import type { AxiosInstance } from 'axios';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { trapNetwork } from '../../fakes/no-network.js';
import { installStubNetwork, type StubCall, type StubTable } from '../../fakes/stub-network.js';
import { quickbooksFake, type QuickbooksAnswer, type QuickbooksFakeOpts } from '../../fakes/quickbooks.js';
import { stacksFake, type StacksAnswer, type StacksStep } from '../../fakes/stacks-token.js';
import { startTestGuard } from '../../helpers/guard.js';
import { guardedAxios } from '../../../src/http-guard.js';
import { parseCompanies } from '../../../src/clients/companies.js';
import { currentCall, runInCall, setCallToken, type Failure } from '../../../src/clients/call-context.js';
import type { Config } from '../../../src/clients/config.js';
import { createRealmStore, StacksTokenClient, type RealmStore } from '../../../src/clients/stacks-token.js';
import { installQboInterceptors, QBO_LIMIT_MS } from '../../../src/clients/qbo-transport.js';
import { createCompanyState, type CompanyState } from '../../../src/clients/company-state.js';
import { QuickbooksClient } from '../../../src/clients/quickbooks-client.js';

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
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const COMPANIES = parseCompanies(readFileSync(fakes('entities.json'), 'utf8'));
const KEYS = COMPANIES.map((c) => c.key);

const STACKS = 'https://stacks.example.test';
const QBO_HOST = 'quickbooks.api.intuit.com';
const QBO = `https://${QBO_HOST}`;
// Built at runtime: no secret-shaped literal sits in this file.
const KEY = ['fake', 'stacks', 'key'].join('-');
const ACCESS_A = ['qbo', 'test', 'access', 'a'].join('-');
const ACCESS_B = ['qbo', 'test', 'access', 'b'].join('-');
const FIXTURE_TOKEN = (key: string) => ['qbo', 'fake', 'access', 'token', key].join('-');
const SECRETS = [KEY, ACCESS_A, ACCESS_B, ...KEYS.map(FIXTURE_TOKEN)];

const REALM = '9990000000000002'; // garden3d's, in 200-garden3d.json
const REALM_USB = '9990000000000004'; // usb-club's, in 200-usb-club.json
const EXPIRES = '2026-11-18T12:00:00Z';
const NOW = Date.parse(EXPIRES) - 50 * 60_000;

const cfgOf = (companies = COMPANIES): Config => ({ stacksUrl: new URL(STACKS), stacksKey: KEY, companies, mode: 'read' });

/** A get_company_info tool-result fixture's data item (the CompanyInfo QuickBooks answered), or its error's header lines. */
const result = (name: string): string => JSON.parse(readFileSync(fakes(`tool-results/get_company_info/${name}.json`), 'utf8')).content[0].text;
const infoOf = (name: string): Record<string, unknown> => JSON.parse(result(name));
const headerOf = (name: string): Record<string, string> =>
  Object.fromEntries(
    result(name)
      .split('\n\n')[0]
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]),
  );

const GARDEN_OK = infoOf('ok-garden3d');
const USB_OK = infoOf('ok-usb-club');
const LEGAL_ONLY = infoOf('ok-legal-name-only');
const UNACCEPTED = infoOf('ok-unaccepted-name');
const UNACCEPTED_LONG = infoOf('ok-unaccepted-long-name');

function tokenBody(access: string, realm = REALM, company = 'garden3d', name = 'garden3d, LLC'): StacksAnswer {
  return {
    status: 200,
    headers: { 'cache-control': 'no-store' },
    body: { enterprise: company, realm_id: realm, access_token: access, expires_at: EXPIRES, company_name: name },
  };
}

type Rig = {
  qbo: ReturnType<typeof quickbooksFake>;
  qboOpts: QuickbooksFakeOpts;
  stacks: ReturnType<typeof stacksFake>;
  realms: RealmStore;
  client: StacksTokenClient;
  state: CompanyState;
  forced: string[];
};

let ejectors: Array<() => void> = [];
/**
 * The stub routes by host: QuickBooks' to the QuickBooks fake (each company's CompanyInfo at its realm unless `qbo` says
 * otherwise), every other to the Stacks fake (each key's 200 fixture unless `stacks` gives a sequence).
 */
function rig(opts: { qbo?: QuickbooksFakeOpts; stacks?: StacksStep[]; cfg?: Config } = {}): Rig {
  const qboOpts: QuickbooksFakeOpts = { companyInfo: { [REALM]: GARDEN_OK, [REALM_USB]: USB_OK }, ...opts.qbo };
  const qbo = quickbooksFake(qboOpts);
  const stacks = stacksFake(opts.stacks ? { sequence: opts.stacks } : {});
  table = (call) => (call.hostname === QBO_HOST ? qbo.handler(call) : stacks.handler(call));
  const cfg = opts.cfg ?? cfgOf();
  const realms = createRealmStore();
  const client = new StacksTokenClient(cfg, realms, { now: () => NOW });
  const forced: string[] = [];
  const reacquire = (company: string) => {
    forced.push(company);
    return client.get(company, { force: true });
  };
  const sleep = async () => {};
  ejectors.push(installQboInterceptors(guardedAxios() as unknown as AxiosInstance, { reacquire, secrets: () => [currentCall()?.token, KEY], sleep }).eject);
  return { qbo, qboOpts, stacks, realms, client, state: createCompanyState(cfg, client, realms), forced };
}

/** Every failure a case saw (prepareCall's answers and the calls' recorded failures): none may hold a token or the key. */
const seenFailures: Failure[] = [];
const note = (f: Failure | null | undefined) => {
  if (f) seenFailures.push(f);
};

/** One tool call for `company`: prepareCall, then `then` (the tool's own requests) when the call may go on. */
function call<T>(r: Rig, company: string, then?: () => Promise<T>): Promise<{ failure: Failure | null; out?: T }> {
  return runInCall(company, async () => {
    const failure = await r.state.prepareCall(company);
    note(failure);
    const out = failure === null && then ? await then() : undefined;
    note(currentCall()!.failure);
    return { failure, out };
  });
}

/** A tool's own read, as 285's get_company_info handler makes it: getInstance, then node-quickbooks' getCompanyInfo. */
async function toolRead(id?: string): Promise<{ err: unknown; info: any }> {
  const qb: any = await QuickbooksClient.getInstance();
  return new Promise((resolve) => qb.getCompanyInfo(id ?? qb.realmId, (err: unknown, info: unknown) => resolve({ err, info })));
}

const infoPath = (realm: string) => `/v3/company/${realm}/companyinfo/${realm}?minorversion=75&format=json`;
const paths = (calls: StubCall[]) => calls.map((c) => c.path);
const header = (c: StubCall, name: string): unknown => Object.entries(c.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
const bearers = (calls: StubCall[]) => calls.map((c) => header(c, 'authorization'));
const a = (status: number, headers?: Record<string, string>, body?: unknown): QuickbooksAnswer => ({ status, headers, body });
/** Lets queued promise and I/O callbacks run (the stub network answers on microtasks). */
const ticks = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((res) => setImmediate(res));
};

let stderr: string[] = [];
let restoreGuard: () => void;
beforeEach(() => {
  stderr = [];
  jest.spyOn(process.stderr, 'write').mockImplementation(((s: unknown) => {
    stderr.push(String(s));
    return true;
  }) as any);
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void stderr.push(args.map(String).join(' ')));
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
    expect(seenFailures.length).toBeGreaterThan(25);
  }
});

describe('A3.3: getInstance reads the call, and only the call', () => {
  it('outside a tool call it throws exactly Error("getInstance outside a tool call")', async () => {
    const e = await QuickbooksClient.getInstance().then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).toEqual(new Error('getInstance outside a tool call'));
    expect(net.calls).toHaveLength(0);
  });

  it("inside a call: the client sends the call's token and realm, and holds no client id, secret or refresh token", async () => {
    const r = rig();
    const qb: any = await runInCall('garden3d', async () => {
      setCallToken(ACCESS_A, REALM);
      const instance = await QuickbooksClient.getInstance();
      const out = await toolRead();
      expect(out.err).toBeFalsy();
      expect(out.info).toEqual(GARDEN_OK);
      return instance;
    });
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM)]);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`]);
    expect(r.stacks.requests).toHaveLength(0);
    expect([qb.consumerKey, qb.consumerSecret, qb.tokenSecret, qb.refreshToken]).toEqual(['', '', false, null]);
    expect([qb.oauthversion, qb.useSandbox, qb.debug, qb.endpoint]).toEqual(['2.0', false, false, `${QBO}/v3/company/`]);
  });

  it('two overlapping calls each send their own token and realm (no shared current company)', async () => {
    const r = rig();
    let release!: () => void;
    r.qboOpts.holdUntil = new Promise<void>((res) => (release = res));
    const one = runInCall('garden3d', async () => {
      setCallToken(ACCESS_A, REALM);
      return toolRead();
    });
    const two = runInCall('usb-club', async () => {
      setCallToken(ACCESS_B, REALM_USB);
      return toolRead();
    });
    await ticks();
    release();
    const [o1, o2] = await Promise.all([one, two]);
    expect([o1.info, o2.info]).toEqual([GARDEN_OK, USB_OK]);
    const sent = r.qbo.requests.map((c) => [c.path, header(c, 'authorization')]);
    expect(sent).toEqual([
      [infoPath(REALM), `Bearer ${ACCESS_A}`],
      [infoPath(REALM_USB), `Bearer ${ACCESS_B}`],
    ]);
  });

  it('the token and realm are read when each request is sent, not when the client was built (T6-4)', async () => {
    const r = rig();
    await runInCall('garden3d', async () => {
      // Built before the call holds any token or realm.
      const qb: any = await QuickbooksClient.getInstance();
      setCallToken(ACCESS_A, REALM);
      await new Promise((res) => qb.getCompanyInfo(REALM, res));
      setCallToken(ACCESS_B, REALM);
      await new Promise((res) => qb.getCompanyInfo(REALM, res));
    });
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM), infoPath(REALM)]);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`]);
  });

  it("after a 401 resend replaced the call's token, the call's next request carries the new token", async () => {
    const r = rig({ qbo: { answers: [a(401)] }, stacks: [tokenBody(ACCESS_A), tokenBody(ACCESS_B)] });
    const o = await call(r, 'garden3d', async () => {
      const qb: any = await QuickbooksClient.getInstance();
      const first = await new Promise<unknown>((res) => qb.getCompanyInfo(REALM, (err: unknown) => res(err)));
      const second = await new Promise<unknown>((res) => qb.getCompanyInfo(REALM, (err: unknown) => res(err)));
      return [first, second];
    });
    expect(o).toEqual({ failure: null, out: [null, null] });
    // The first-use read (401, resent with B), then the tool's two reads: both with B, and no third Stacks request.
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`]);
    expect(r.stacks.requests).toHaveLength(2);
    expect(r.forced).toEqual(['garden3d']);
  });

  it('source: no module-level current company in the client or the company state, and neither reads process.env', () => {
    for (const file of ['src/clients/quickbooks-client.ts', 'src/clients/company-state.ts']) {
      const text = readFileSync(ROOT + file, 'utf8');
      const topLevel = text.split('\n').filter((l) => /^\S/.test(l) && !/^\s*(\/\/|\*|\/\*\*)/.test(l));
      // No module-level variable, and no module-level Map, Set or store (the state is built in createCompanyState).
      expect(topLevel.filter((l) => /^(export\s+)?(let|var)\s/.test(l))).toEqual([]);
      expect(topLevel.filter((l) => /\bnew\s+(Map|Set|WeakMap|AsyncLocalStorage)\b/.test(l))).toEqual([]);
      expect(text).not.toMatch(/\bprocess\s*(?:\.\s*env\b|\[)/);
      // No refresh, client id or secret material and no disk write on the token path.
      expect(text).not.toMatch(/refresh_?token|client_?(id|secret)|writeFile|appendFile|createWriteStream/i);
    }
  });
});

describe('A3.5: the guard allows only the current call\'s kept realm', () => {
  it("inside a garden3d call, a request to usb-club's realm is refused before sending, though usb-club's realm is kept", async () => {
    const r = rig();
    expect((await call(r, 'usb-club')).failure).toBeNull();
    expect(r.realms.kept('usb-club')).toBe(REALM_USB);
    r.qbo.requests.length = 0;
    /** A companyinfo GET for `realm`, made in the call as node-quickbooks makes it; its recorded failure, or 'sent'. */
    const readRealm = (realm: string) =>
      guardedAxios()({ method: 'get', url: `${QBO}/v3/company/${realm}/companyinfo/${realm}`, params: { minorversion: '75', format: 'json' }, headers: { Authorization: `Bearer ${currentCall()!.token}` } }).then(
        () => 'sent',
        () => currentCall()!.failure,
      );
    const o = await call(r, 'garden3d', async () => [await readRealm(REALM_USB), await readRealm(REALM)]);
    expect(o).toEqual({ failure: null, out: [{ reason: 'fork-error' }, 'sent'] });
    // garden3d's first-use read and its own realm's read went; usb-club's realm was never sent.
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM), infoPath(REALM)]);
  });

  it("no realm kept (the first token's name mismatched): every realm is refused, the company's own included", async () => {
    const r = rig({ stacks: [tokenBody(ACCESS_A, REALM, 'garden3d', 'Garden Three Studio')] });
    const o = await runInCall('garden3d', async () => {
      const f = await r.state.prepareCall('garden3d');
      note(f);
      expect(currentCall()!.realm).toBeUndefined();
      const viaClient = await toolRead(REALM);
      const own = guardedAxios()({ method: 'get', url: `${QBO}/v3/company/${REALM}/companyinfo/${REALM}` }).then(
        () => 'sent',
        () => currentCall()!.failure,
      );
      return { f, viaClient: viaClient.err !== null, own: await own };
    });
    expect(o).toEqual({ f: { reason: 'name-mismatch', source: 'stacks', reported: 'Garden Three Studio' }, viaClient: true, own: { reason: 'fork-error' } });
    expect(r.realms.kept('garden3d')).toBeUndefined();
    expect(r.qbo.requests).toHaveLength(0);
  });

  it('no token fetched yet in the call: a request through getInstance is refused, nothing sent', async () => {
    const r = rig();
    const f = await runInCall('garden3d', async () => {
      await toolRead();
      return currentCall()!.failure;
    });
    note(f);
    expect(f).toEqual({ reason: 'fork-error' });
    expect(r.qbo.requests).toHaveLength(0);
  });
});

describe("A2.3: QuickBooks' names on first use", () => {
  it('CompanyName matching: the first call reads companyinfo/<realm> before the tool\'s request; later calls do not read it', async () => {
    const r = rig();
    const one = await call(r, 'garden3d', () => toolRead());
    expect(one.failure).toBeNull();
    expect(one.out!.info).toEqual(GARDEN_OK);
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM), infoPath(REALM)]);
    const two = await call(r, 'garden3d', async () => {
      await guardedAxios()({ method: 'get', url: `${QBO}/v3/company/${REALM}/query`, params: { query: 'select * from Account maxresults 10', minorversion: '75' }, headers: { Authorization: `Bearer ${currentCall()!.token}` } });
    });
    expect(two.failure).toBeNull();
    // The second call made only its own request, and used the kept token (one Stacks request in all).
    expect(r.qbo.requests).toHaveLength(3);
    expect(r.qbo.requests[2].path).toMatch(/\/query\?/);
    expect(r.stacks.requests).toHaveLength(1);
    expect(r.realms.kept('garden3d')).toBe(REALM);
  });

  it('the read is per company: usb-club\'s first call reads its own companyinfo after garden3d passed', async () => {
    const r = rig();
    await call(r, 'garden3d');
    expect((await call(r, 'usb-club')).failure).toBeNull();
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM), infoPath(REALM_USB)]);
  });

  it('only LegalName matching (ok-legal-name-only): the call goes on', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: LEGAL_ONLY } } });
    expect(matchesName(LEGAL_ONLY.CompanyName)).toBe(false);
    expect((await call(r, 'garden3d')).failure).toBeNull();
    expect((await call(r, 'garden3d')).failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('neither matching: exactly name-mismatch-quickbooks.json, reported the CompanyName', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED } } });
    const o = await call(r, 'garden3d', () => toolRead());
    expect(o.failure).toEqual(headerOf('name-mismatch-quickbooks'));
    expect(o.failure).toEqual({ reason: 'name-mismatch', source: 'quickbooks', reported: 'Garden Three Studio' });
    expect(Object.isFrozen(o.failure)).toBe(true);
    // The tool's own request is never made.
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM)]);
  });

  it('reported: is the CompanyName after the name rule (ok-unaccepted-long-name)', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED_LONG } } });
    const o = await call(r, 'garden3d');
    const reported = Array.from((UNACCEPTED_LONG.CompanyName as string).replace(/\n/g, ' ')).slice(0, 200).join('').trimEnd();
    expect(o.failure).toEqual({ reason: 'name-mismatch', source: 'quickbooks', reported });
  });

  it('CompanyName present but unaccepted and LegalName absent: reported the CompanyName', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: { CompanyName: 'Garden Three Studio' } } } });
    expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'name-mismatch', source: 'quickbooks', reported: 'Garden Three Studio' });
  });

  for (const [label, absent] of [
    ['a number', 7],
    ['only spaces', '   '],
  ] as const) {
    it(`CompanyName absent (${label}) and LegalName present but not accepted: reported the LegalName`, async () => {
      const r = rig({ qbo: { companyInfo: { [REALM]: { CompanyName: absent, LegalName: ' Garden Three Holdings LLC ' } } } });
      expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'name-mismatch', source: 'quickbooks', reported: 'Garden Three Holdings LLC' });
    });
  }

  it('names are matched as read, before the name rule: a 230-character accepted name matches though its cleaned form would not', async () => {
    const long = 'Garden ' + 'x'.repeat(220) + ' LLC';
    const companies = parseCompanies(
      JSON.stringify({ v: '1.0', companies: [{ stacks_key: 'garden3d', name: 'garden3d, LLC', accepted_names: ['garden3d, LLC', long] }] }),
    );
    const r = rig({ cfg: cfgOf(companies), qbo: { companyInfo: { [REALM]: { CompanyName: long } } } });
    expect((await call(r, 'garden3d')).failure).toBeNull();
  });
});

const matchesName = (n: unknown) => typeof n === 'string' && ['garden3d, LLC', 'Garden Three LLC'].includes(n);

describe('A2.4: a QuickBooks mismatch refuses the company until restart', () => {
  it('the next three calls answer the same result with no request; another company is unaffected; a fresh state checks again', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED, [REALM_USB]: USB_OK } } });
    const first = (await call(r, 'garden3d')).failure;
    expect(first).toEqual(headerOf('name-mismatch-quickbooks'));
    expect(r.realms.refused('garden3d')).toBe(first);
    const before = { stacks: r.stacks.requests.length, qbo: r.qbo.requests.length };
    for (let i = 0; i < 3; i++) expect((await call(r, 'garden3d', () => toolRead())).failure).toEqual(first);
    expect({ stacks: r.stacks.requests.length, qbo: r.qbo.requests.length }).toEqual(before);
    // usb-club is unaffected.
    expect((await call(r, 'usb-club')).failure).toBeNull();
    expect(r.realms.refused('usb-club')).toBeUndefined();
    // A restart: a new state, client and realm store, with QuickBooks now naming garden3d rightly, checks again.
    const fresh = rig();
    expect((await call(fresh, 'garden3d')).failure).toBeNull();
    expect(paths(fresh.qbo.requests)).toEqual([infoPath(REALM)]);
  });

  it('a new createCompanyState over the same client and store keeps the refusal (only a restart clears it)', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED } } });
    const first = (await call(r, 'garden3d')).failure;
    const again = createCompanyState(cfgOf(), r.client, r.realms);
    const n = r.qbo.requests.length;
    const o = await runInCall('garden3d', () => again.prepareCall('garden3d'));
    expect(o).toEqual(first);
    expect(r.qbo.requests).toHaveLength(n);
  });

  it('a new createCompanyState with a new realm store checks again', async () => {
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED } } });
    await call(r, 'garden3d');
    r.qboOpts.companyInfo = { [REALM]: GARDEN_OK };
    const realms = createRealmStore();
    const client = new StacksTokenClient(cfgOf(), realms, { now: () => NOW });
    const o = await runInCall('garden3d', () => createCompanyState(cfgOf(), client, realms).prepareCall('garden3d'));
    expect(o).toBeNull();
    expect(paths(r.qbo.requests)).toEqual([infoPath(REALM), infoPath(REALM)]);
  });
});

describe('A2.5: a failed first-use read keeps nothing, and the next call reads again', () => {
  /** After a failed first call: nothing kept or refused, and the next call reads companyinfo again and passes. */
  async function readsAgain(r: Rig, qboBefore: number) {
    expect(r.realms.refused('garden3d')).toBeUndefined();
    const next = await call(r, 'garden3d');
    expect(next.failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(qboBefore + 1);
    expect(r.qbo.requests[qboBefore].path).toBe(infoPath(REALM));
    // And now it has passed: a third call reads nothing.
    expect((await call(r, 'garden3d')).failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(qboBefore + 1);
  }

  it('Stacks 409: not-connected, no QuickBooks request', async () => {
    const r = rig({ stacks: ['409.json', '200-garden3d.json'] });
    expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'not-connected' });
    expect(r.qbo.requests).toHaveLength(0);
    await readsAgain(r, 0);
  });

  it('QuickBooks 500 with an intuit_tid: http-500 with it', async () => {
    const r = rig({ qbo: { answers: [a(500, { intuit_tid: 'fake-tid-0001' }, { Fault: { Error: [{ Message: 'boom' }] } })] } });
    const o = await call(r, 'garden3d');
    expect(o.failure).toEqual({ reason: 'http-500', intuitTid: headerOf('http-500').intuit_tid });
    await readsAgain(r, 1);
  });

  it('a QuickBooks timeout: timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const r = rig({ qbo: { holdUntil: new Promise<void>(() => {}) } });
    const p = call(r, 'garden3d');
    await jest.advanceTimersByTimeAsync(QBO_LIMIT_MS);
    expect((await p).failure).toEqual({ reason: 'timeout' });
    jest.useRealTimers();
    r.qboOpts.holdUntil = undefined;
    await readsAgain(r, 1);
  });

  for (const [label, info] of [
    ['non-strings', { CompanyName: 5, LegalName: null }],
    ['only spaces', { CompanyName: '  ', LegalName: '\n\t ' }],
    ['no names', {}],
  ] as const) {
    it(`a success whose names are both absent (${label}): fork-error, never name-mismatch with an empty name`, async () => {
      const r = rig({ qbo: { answers: [a(200, undefined, { CompanyInfo: info })] } });
      expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'fork-error' });
      await readsAgain(r, 1);
    });
  }

  it('a 200 whose body is a Fault (node-quickbooks calls it an error, the interceptors record nothing): fork-error', async () => {
    const r = rig({ qbo: { answers: [a(200, undefined, { Fault: { Error: [{ Message: 'odd' }] } })] } });
    expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'fork-error' });
    await readsAgain(r, 1);
  });

  it('a 200 whose body is JSON null (node-quickbooks hands back null): fork-error', async () => {
    const r = rig({ qbo: { answers: [a(200, undefined, 'null')] } });
    expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'fork-error' });
    await readsAgain(r, 1);
  });

  it('a 200 with a non-object body: fork-error', async () => {
    const r = rig({ qbo: { answers: [a(200, undefined, 'not json')] } });
    expect((await call(r, 'garden3d')).failure).toEqual({ reason: 'fork-error' });
    await readsAgain(r, 1);
  });
});

describe('A2.9: concurrent first calls share one companyinfo read', () => {
  it('two calls started together make one read; on a mismatch both answer the same name-mismatch', async () => {
    let release!: () => void;
    const r = rig({ qbo: { companyInfo: { [REALM]: UNACCEPTED }, holdUntil: new Promise<void>((res) => (release = res)) } });
    const one = call(r, 'garden3d');
    const two = call(r, 'garden3d');
    await ticks();
    // Both calls are waiting on the one read, which QuickBooks has not answered yet.
    expect(r.qbo.requests).toHaveLength(1);
    release();
    const [o1, o2] = await Promise.all([one, two]);
    expect(o1.failure).toEqual(headerOf('name-mismatch-quickbooks'));
    expect(o2.failure).toBe(o1.failure);
    expect(r.qbo.requests).toHaveLength(1);
    expect(r.stacks.requests).toHaveLength(1);
  });

  it('a shared read that passes lets both calls go on; a later call reads nothing', async () => {
    let release!: () => void;
    const r = rig({ qbo: { holdUntil: new Promise<void>((res) => (release = res)) } });
    const both = Promise.all([call(r, 'garden3d'), call(r, 'garden3d')]);
    await ticks();
    release();
    expect((await both).map((o) => o.failure)).toEqual([null, null]);
    expect((await call(r, 'garden3d')).failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(1);
  });

  it('a shared read that fails fails both, and the next call reads again', async () => {
    let release!: () => void;
    const r = rig({ qbo: { answers: [a(500, { intuit_tid: 'fake-tid-0001' })], holdUntil: new Promise<void>((res) => (release = res)) } });
    const both = Promise.all([call(r, 'garden3d'), call(r, 'garden3d')]);
    await ticks();
    release();
    const [o1, o2] = await both;
    expect(o1.failure).toEqual({ reason: 'http-500', intuitTid: 'fake-tid-0001' });
    expect(o2.failure).toBe(o1.failure);
    expect((await call(r, 'garden3d')).failure).toBeNull();
    expect(r.qbo.requests).toHaveLength(2);
  });
});

describe("A1.3b (T5-3's ruling): a forced get joins a forced flight in progress", () => {
  it('two requests of one call both get a 401: one forced Stacks fetch, both resent with its token, no third Stacks request', async () => {
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    const r = rig({ qbo: { answers: [a(200, undefined, { CompanyInfo: GARDEN_OK }), a(401), a(401)] }, stacks: [tokenBody(ACCESS_A), { answer: tokenBody(ACCESS_B), hold: held }] });
    const o = await call(r, 'garden3d', async () => {
      const qb: any = await QuickbooksClient.getInstance();
      const read = () => new Promise<unknown>((res) => qb.getCompanyInfo(REALM, (err: unknown) => res(err)));
      const both = Promise.all([read(), read()]);
      // Hold the forced fetch until the second 401 has asked for it too.
      for (let i = 0; i < 100 && r.forced.length < 2; i++) await ticks(1);
      expect(r.forced).toEqual(['garden3d', 'garden3d']);
      release();
      return both;
    });
    expect(o).toEqual({ failure: null, out: [null, null] });
    expect(r.stacks.requests).toHaveLength(2);
    expect(bearers(r.qbo.requests)).toEqual([`Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_A}`, `Bearer ${ACCESS_B}`, `Bearer ${ACCESS_B}`]);
  });
});
